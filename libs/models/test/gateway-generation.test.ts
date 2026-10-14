import { expect, it } from 'vitest';
import { type AppendCommand, type AppendResult, type EventStore,
  type StoredEvent } from '@opencrane/event-store';
import { parseEventByType, type EventEnvelope } from '@opencrane/events';
import { catalogueDigest, toolReviewDigest } from '@opencrane/events/mcp-catalogue';
import { losslessJson } from '@opencrane/events/lossless-json';
import { envelope, history } from '../src/actor.ts';
import { prepareGatewayConfiguration, gatewayConfigurationCurrent } from '../src/gateway-generation.ts';
import { publicationDigest, publicationEntry } from '../src/publication.ts';
import { toolPolicyFromRows } from '../src/tool-policy.ts';

type ConfigurationStore = Pick<EventStore, 'append' | 'head' | 'readEvent' | 'readStream'>;

function conditionalStore() {
  const rows: StoredEvent[] = [];
  function position(subject?: string) {
    for (let index = rows.length - 1; index >= 0; index--) {
      const row = rows[index]!;
      if (subject === undefined || row.event.subject === subject) {
        return row.sequence;
      }
    }
    return 0;
  }
  function head(subject?: string) {
    return Promise.resolve(position(subject));
  }
  function append(command: AppendCommand): Promise<AppendResult> {
    const parsed = parseEventByType(command.event);
    if (!parsed.success) {
      throw new Error('Invalid fixture event');
    }
    if (position(parsed.event.subject) !== command.expectedSequence) {
      return Promise.resolve({ status: 'conflict' });
    }
    const sequence = rows.length + 1;
    rows.push({ event: parsed.event, sequence });
    return Promise.resolve({ status: 'appended', sequence });
  }
  async function* readStream(subject: string, fromSequence = 1) {
    for (const row of rows) {
      await Promise.resolve();
      if (row.event.subject === subject && row.sequence >= fromSequence) {
        yield row;
      }
    }
  }
  function readEvent(sequence: number) {
    const row = rows[sequence - 1];
    if (!row) {
      throw new Error('Missing fixture event');
    }
    return Promise.resolve(row);
  }
  const store = { append, head, readStream, readEvent };
  return store;
}

async function save(store: ConfigurationStore, event: EventEnvelope) {
  const expectedSequence = await store.head(event.subject);
  const result = await store.append({ event, expectedSequence });
  expect(result.status).toBe('appended');
}

async function saveIntent(store: ConfigurationStore, serverId: string, changeRef: string,
  mode: 'allow' | 'block') {
  const subject = `mcp-${serverId}`;
  if (await store.head(subject) === 0) {
    const definition = '{"inputSchema":{"type":"object"},"name":"read"}';
    const tool = { name: 'read', definition, revision: losslessJson(definition).digest,
      reviewed: false, costCents: 0 as const };
    const tools = [tool];
    const now = Date.now();
    const catalogue = { serverId, connectionId: `installed-${serverId}`, accountMode: 'none',
      toolCount: 1, tools, schemaDigest: catalogueDigest(tools),
      checkedAt: new Date(now).toISOString(), expiresAt: new Date(now + 300_000).toISOString() };
    await save(store, envelope('test', subject, 'mcp.server_discovered', catalogue));
  }
  const rows = await history(store, subject, 'test');
  const state = toolPolicyFromRows(rows);
  const declaration = state.catalogue!.tools![0]!;
  const choice = { name: declaration.name, revision: declaration.revision,
    reviewDigest: toolReviewDigest(declaration), mode };
  const review = { serverId, connectionId: state.connectionId, accountMode: 'none',
    catalogueDigest: state.catalogue!.schemaDigest, policyRevision: state.policyRevision,
    reviewedBy: 'admin', tools: [choice] };
  const event = envelope('test', subject, 'mcp.server_reviewed', review);
  const reviewed = { ...event, principal: { kind: 'human' as const, id: 'admin' } };
  await save(store, reviewed);
  const reviewedRows = await history(store, subject, 'test');
  const policy = toolPolicyFromRows(reviewedRows);
  const entry = publicationEntry(policy);
  expect(entry).not.toBeNull();
  const intent = { serverId, publishedBy: 'admin', commandId: changeRef,
    expectedSequence: policy.sequence, reviewRevision: policy.reviewRevision,
    fragmentDigest: publicationDigest(entry) };
  await save(store, envelope('test', subject, 'mcp.server_published', intent, changeRef));
}

async function preparesReplacementIntents() {
  const store = conditionalStore();
  await saveIntent(store, 'alpha', 'alpha-1', 'allow');
  const first = await prepareGatewayConfiguration(store, 'test', 'alpha', 'alpha-1');
  await saveIntent(store, 'bravo', 'bravo-1', 'allow');
  const second = await prepareGatewayConfiguration(store, 'test', 'bravo', 'bravo-1');
  expect(first.generation).toBe(1);
  expect(second.generation).toBe(2);
  await saveIntent(store, 'alpha', 'alpha-2', 'block');
  await saveIntent(store, 'bravo', 'bravo-2', 'block');

  const third = await prepareGatewayConfiguration(store, 'test', 'alpha', 'alpha-2');
  expect(third.generation).toBe(3);
  expect(third.members).toHaveLength(2);
  expect(third.members[0]).toEqual(second.members[1]);
  expect(third.members[1]).toMatchObject({ changeRef: 'alpha-2',
    entry: { serverId: 'alpha', tools: [{ name: 'read', mode: 'block' }] } });
  expect(await gatewayConfigurationCurrent(store, 'test', third)).toBe(false);

  const fourth = await prepareGatewayConfiguration(store, 'test', 'bravo', 'bravo-2');
  expect(fourth.generation).toBe(4);
  expect(fourth.members).toHaveLength(2);
  expect(fourth.members[0]).toEqual(third.members[1]);
  expect(fourth.members[1]).toMatchObject({ changeRef: 'bravo-2',
    entry: { serverId: 'bravo', tools: [{ name: 'read', mode: 'block' }] } });
  expect(await gatewayConfigurationCurrent(store, 'test', fourth)).toBe(true);
  expect(await history(store, 'gateway-config-test', 'test')).toHaveLength(4);
}
it('prepares both replacement intents as separate serial generations', preparesReplacementIntents);

const invalidations = ['unpublish', 'review', 'mode', 'tools', 'rejection', 'failed check',
  'new intent'] as const;
async function invalidatesChangedPolicy(change: typeof invalidations[number]) {
  const store = conditionalStore();
  await saveIntent(store, 'alpha', 'alpha-1', 'allow');
  const record = await prepareGatewayConfiguration(store, 'test', 'alpha', 'alpha-1');
  const before = toolPolicyFromRows(await history(store, 'mcp-alpha', 'test'));
  const tool = before.tools[0]!;
  const changes = {
    unpublish: ['mcp.server_unpublished', { serverId: 'alpha', unpublishedBy: 'admin' }],
    mode: ['mcp.tool_mode_set', { serverId: 'alpha', connectionId: before.connectionId,
      toolName: tool.name, toolRevision: tool.revision, mode: 'block', setBy: 'admin' }],
    tools: ['mcp.tools_changed', { serverId: 'alpha',
      previousSchemaDigest: before.catalogue!.schemaDigest, newSchemaDigest: 'b'.repeat(64) }],
    rejection: ['mcp.server_rejected', { serverId: 'alpha', reason: 'connection_required' }],
    'failed check': ['mcp.catalogue_checked', { serverId: 'alpha', outcome: 'failed',
      checkedAt: new Date().toISOString(), reason: 'discovery_timeout' }],
    'new intent': ['mcp.server_published', { ...before.publication!, commandId: 'alpha-2' }],
  } as const;
  if (change === 'review') {
    await saveIntent(store, 'alpha', 'alpha-2', 'allow');
  } else {
    const [type, data] = changes[change];
    await save(store, envelope('test', 'mcp-alpha', type, data));
  }
  expect(await gatewayConfigurationCurrent(store, 'test', record)).toBe(false);
}
it.each(invalidations)('invalidates a prepared member after %s', invalidatesChangedPolicy);

async function retainsCurrentPolicy() {
  const store = conditionalStore();
  await saveIntent(store, 'alpha', 'alpha-1', 'allow');
  const record = await prepareGatewayConfiguration(store, 'test', 'alpha', 'alpha-1');
  const before = toolPolicyFromRows(await history(store, 'mcp-alpha', 'test'));
  const tool = before.tools[0]!;
  const events = [
    envelope('test', 'mcp-alpha', 'mcp.catalogue_checked', { serverId: 'alpha',
      schemaDigest: before.catalogue!.schemaDigest, outcome: 'unchanged',
      checkedAt: before.checkedAt, expiresAt: before.expiresAt }),
    envelope('test', 'mcp-alpha', 'mcp.dispatch_admitted', { serverId: 'alpha',
      connectionId: before.connectionId, requestId: 'call', toolName: tool.name,
      toolRevision: tool.revision, schemaDigest: before.catalogue!.schemaDigest,
      generation: 'instance-1' }),
  ];
  for (const event of events) {
    await save(store, event);
    expect(await gatewayConfigurationCurrent(store, 'test', record)).toBe(true);
  }
  const after = toolPolicyFromRows(await history(store, 'mcp-alpha', 'test'));
  expect(after.policyRevision).toBe(before.policyRevision);
}
it('keeps members current after unchanged checks and call admission', retainsCurrentPolicy);

async function refusesUnrelatedReceipts() {
  const store = conditionalStore();
  await saveIntent(store, 'alpha', 'alpha-1', 'allow');
  const record = await prepareGatewayConfiguration(store, 'test', 'alpha', 'alpha-1');
  const member = record.members[0]!;
  const valid = { serverId: 'alpha', changeRef: member.changeRef,
    reviewRevision: member.entry.reviewRevision, fragmentDigest: member.fragmentDigest,
    sourceSequence: member.sourceSequence, generation: record.generation,
    recordDigest: record.recordDigest, configDigest: 'a'.repeat(64),
    processRef: '00000000-0000-4000-8000-000000000001', observedAt: new Date().toISOString() };
  for (const fields of [{ changeRef: 'old' }, { fragmentDigest: 'b'.repeat(64) },
    { reviewRevision: 1 }, { sourceSequence: 1 }, { sourceSequence: 1000 }]) {
    await save(store, envelope('test', 'mcp-alpha', 'mcp.configuration_observed',
      { ...valid, ...fields }));
    const policy = toolPolicyFromRows(await history(store, 'mcp-alpha', 'test'));
    expect(policy).not.toHaveProperty('configurationObservation');
  }
  await save(store, envelope('test', 'mcp-bravo', 'mcp.configuration_observed',
    { ...valid, serverId: 'bravo' }));
  const other = toolPolicyFromRows(await history(store, 'mcp-bravo', 'test'));
  expect(other).not.toHaveProperty('configurationObservation');
  await save(store, envelope('test', 'mcp-alpha', 'mcp.server_unpublished',
    { serverId: 'alpha', unpublishedBy: 'admin' }));
  await save(store, envelope('test', 'mcp-alpha', 'mcp.configuration_observed', valid));
  const late = toolPolicyFromRows(await history(store, 'mcp-alpha', 'test'));
  expect(late.configurationObservation).toBeUndefined();
  expect(await gatewayConfigurationCurrent(store, 'test', record)).toBe(false);
}
it('ignores old, unrelated and late member receipts', refusesUnrelatedReceipts);
