import { connectMcpCatalogue } from '@opencrane/projections';
import { decodeJwt } from 'jose';
import { releaseTurnCredentials } from '../src/chat/turn-credentials.ts';
import { randomUUID } from 'node:crypto';
import { expect, it, onTestFinished } from 'vitest';
import { fixture } from '@opencrane/models/testing';
import { memberAuthorisation } from '@opencrane/authz';
import { changeConnectionSelection, savePersonalKey, history, envelope } from '@opencrane/models';
import { personalKeyFixture } from './support/personal-key.ts';
import { turnToolReaders } from '../src/chat/turn-tool-readers.ts';
import { buildTurnTools } from '../src/chat/turn-tools.ts';
import { personalConnectionNeeds } from '../src/chat/personal-connection-needs.ts';

async function consentControlsTools() {
  const runtime = await fixture();
  onTestFinished(runtime.close.bind(runtime));
  const setup = await personalKeyFixture(runtime);
  const policy = await setup.publish();
  await setup.project();
  const catalogue = connectMcpCatalogue(runtime.databaseUrl);
  onTestFinished(catalogue.close);
  await setup.grant('alice');
  await setup.grant('bob');
  await setup.grant('assistant', 'assistant');
  const other = envelope('test', 'assistant-other', 'assistant.created', {
    assistantId: 'other', ownerId: 'bob', kind: 'personal',
  });
  await setup.nats.seed([other]);
  await memberAuthorisation(setup.binding).handler.handle(other, setup.db);
  await setup.grant('other', 'assistant');
  function stage() {
    return Promise.resolve({ status: 'staged' as const, identity: {
      reference: 'fixture', uid: 'fixture', resourceVersion: '1',
    } });
  }
  const saved = await savePersonalKey(setup.nats.store, setup.binding, 'alice',
    { custody: { stage }, db: setup.db, network: setup.remote.network }, {
      command: { action: 'create', serverId: setup.serverId, connectionId: policy.connectionId,
        profileId: 'personal', changeRef: randomUUID(), expectedSequence: 0,
        expectedGeneration: 0, appendUntil: Date.now() + 60_000 },
      material: setup.accounts[0].key,
    });
  const command = { action: 'select', serverId: setup.serverId, connectionId: policy.connectionId,
    profileId: 'personal', profileRevision: saved.sequence, expectedSequence: 0,
    changeRef: randomUUID() };
  const initial = await changeConnectionSelection(setup.nats.store, setup.binding, 'alice', command);
  const options = { silo: 'test', store: setup.nats.store, binding: setup.binding, db: setup.db };
  const readers = turnToolReaders(options);
  async function offered(assistantId: string, requesterId = 'alice') {
    return buildTurnTools({ rows: [{ serverId: setup.serverId }], requesterId,
      assistantId, baseMessageBytes: 0, ...readers });
  }
  expect(await offered('assistant')).toHaveLength(1);
  await assertIssuedSelections(runtime, catalogue, [{ serverId: setup.serverId,
    profileId: 'personal', selectionRevision: initial.sequence }]);
  expect(await offered('other')).toEqual([]);
  const old = await history(setup.nats.store,
    `connection-selection-alice-${setup.serverId}`, 'test');
  expect(old[0]?.event.data).not.toHaveProperty('allowedAssistantIds');
  const disabled = await changeConnectionSelection(setup.nats.store, setup.binding, 'alice', {
    ...command, expectedSequence: initial.sequence, changeRef: randomUUID(), allowedAssistantIds: [],
  });
  expect(disabled.sequence).toBeGreaterThan(initial.sequence);
  expect(await offered('assistant')).toEqual([]);
  await assertIssuedSelections(runtime, catalogue, []);
  expect(await personalConnectionNeeds(options, 'alice', 'assistant')).toEqual([{
    serverId: setup.serverId, name: 'OpenCrane demo', reason: 'assistant_not_allowed',
  }]);
  const restored = await changeConnectionSelection(setup.nats.store, setup.binding, 'alice', {
    ...command, expectedSequence: disabled.sequence, changeRef: randomUUID(),
    allowedAssistantIds: ['assistant', 'other'],
  });
  expect(await offered('assistant')).toHaveLength(1);
  expect(await offered('other')).toHaveLength(1);
  expect(await offered('other', 'bob')).toEqual([]);
  const preserved = await changeConnectionSelection(setup.nats.store, setup.binding, 'alice', {
    ...command, expectedSequence: restored.sequence, changeRef: randomUUID(),
  });
  expect(preserved.sequence).toBeGreaterThan(restored.sequence);
  const rows = await history(setup.nats.store,
    `connection-selection-alice-${setup.serverId}`, 'test');
  expect(rows).toHaveLength(4);
  expect(rows.at(-1)?.event.data).toMatchObject({ allowedAssistantIds: ['assistant', 'other'] });
  expect(rows[0]).toEqual(old[0]);
}
it('offers tools only with owner consent, keeps old events and preserves the list on selection',
  consentControlsTools, 120_000);

async function assertIssuedSelections(runtime: Awaited<ReturnType<typeof fixture>>,
  catalogue: ReturnType<typeof connectMcpCatalogue>, expected: unknown[]) {
  const options = { silo: 'test', store: runtime.nats.store, binding: runtime.binding,
    keys: runtime.keys, catalogue };
  const context = { silo: 'test', assistantId: 'assistant', computerId: 'computer' };
  const report = { conversationId: 'conversation', turnId: 'turn', threadId: 'thread' };
  const turn = { ...report, requesterId: 'alice', task: 'chat_turn' as const,
    executionMode: 'memory_free' as const };
  const acknowledgement: { token?: string; refused?: string } = {};
  function delivered() {
    throw new Error('Memory-free turn needs no initial delivery');
  }
  await releaseTurnCredentials(options, context, runtime.tokens, report, turn,
    acknowledgement, delivered);
  expect(acknowledgement.refused).toBeUndefined();
  expect(acknowledgement.token).toBeTruthy();
  const claims = decodeJwt(acknowledgement.token!);
  expect(claims['personalSelections']).toEqual(expected);
}
