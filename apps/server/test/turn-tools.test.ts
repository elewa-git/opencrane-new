import { expect, it, vi } from 'vitest';
import { buildTurnTools, mayOfferTurnTools, toolsForMessage,
  type TurnDelivery, type TurnToolServerState } from '../src/chat/turn-tools.ts';

const toolDefinition = JSON.stringify({ name: 'read', inputSchema: { type: 'object' } });

function serverState(serverId: string, overrides: Partial<TurnToolServerState> = {}) {
  return {
    serverId,
    connectionId: 'connection',
    published: true,
    accountMode: 'none' as const,
    serverInfo: { name: 'Reviewed server', version: '1' },
    discoveryTools: [{ name: 'read', revision: 'a'.repeat(64), definition: toolDefinition }],
    policyTools: [{ name: 'read', revision: 'a'.repeat(64), reviewed: true,
      costCents: 0, mode: 'allow' as const }],
    ...overrides,
  };
}

it('offers only reviewed, zero-cost Allow tools on published credential-free servers', async () => {
  const states = new Map([
    ['allow', serverState('allow')],
    ['ask', serverState('ask', { policyTools: [{ name: 'read', revision: 'a'.repeat(64),
      reviewed: true, costCents: 0, mode: 'ask' }] })],
    ['block', serverState('block', { policyTools: [{ name: 'read', revision: 'a'.repeat(64),
      reviewed: true, costCents: 0, mode: 'block' }] })],
    ['unreviewed', serverState('unreviewed', { policyTools: [{ name: 'read',
      revision: 'a'.repeat(64), reviewed: false, costCents: 0, mode: 'allow' }] })],
    ['credentials', serverState('credentials', { accountMode: 'personal' })],
    ['unpublished', serverState('unpublished', { published: false })],
  ]);
  const canUse = vi.fn((serverId: string, kind: 'person' | 'assistant') =>
    Promise.resolve(serverId !== 'revoked' &&
      !(serverId === 'assistant-denied' && kind === 'assistant')));
  states.set('revoked', serverState('revoked'));
  states.set('assistant-denied', serverState('assistant-denied'));
  const rows = [...states.keys()].map(serverId => ({ serverId }));

  const tools = await buildTurnTools({
    rows,
    requesterId: 'person',
    assistantId: 'assistant',
    baseMessageBytes: 100,
    readServer: serverId => Promise.resolve(states.get(serverId)),
    canUse,
  });

  expect(tools).toHaveLength(1);
  expect(tools[0]).toMatchObject({
    key: 'oc_4100837357',
    serverId: 'allow',
    connectionId: 'connection',
    serverInfo: { name: 'Reviewed server', version: '1' },
    definitions: [toolDefinition],
  });
  expect(JSON.stringify(tools)).not.toContain('discoverResult');
  expect(canUse).toHaveBeenCalledWith('allow', 'person', 'person');
  expect(canUse).toHaveBeenCalledWith('allow', 'assistant', 'assistant');
});

it('drops whole servers when their definitions exceed the message budget', async () => {
  const rows = [{ serverId: 'first' }, { serverId: 'second' }];
  const first = serverState('first', {
    discoveryTools: [{ name: 'read', revision: 'a'.repeat(64),
      definition: JSON.stringify({ name: 'read', description: 'x'.repeat(200) }) }],
  });
  const second = serverState('second');

  const tools = await buildTurnTools({
    rows,
    requesterId: 'person',
    assistantId: 'assistant',
    baseMessageBytes: 120 * 1024 - 100,
    readServer: serverId => Promise.resolve(serverId === 'first' ? first : second),
    canUse: () => Promise.resolve(true),
  });

  expect(tools).toHaveLength(0);
});

it('uses a stable short key for the same server id', async () => {
  const input = {
    rows: [{ serverId: 'stable-server' }],
    requesterId: 'person',
    assistantId: 'assistant',
    baseMessageBytes: 100,
    readServer: () => Promise.resolve(serverState('stable-server')),
    canUse: () => Promise.resolve(true),
  };

  const first = await buildTurnTools(input);
  const second = await buildTurnTools(input);

  expect(first[0]?.key).toBe(second[0]?.key);
});

it('keeps a long UTF-8 message with 100 attachment names below the socket limit', async () => {
  const state = serverState('large');
  state.discoveryTools[0]!.definition = JSON.stringify({
    name: 'read',
    description: 'x'.repeat(5_000),
  });
  const messageWithoutToolsBytes = 32_000 * 3 + 100 * 170;
  const tools = await buildTurnTools({
    rows: [{ serverId: 'large' }],
    requesterId: 'person',
    assistantId: 'assistant',
    baseMessageBytes: messageWithoutToolsBytes,
    readServer: () => Promise.resolve(state),
    canUse: () => Promise.resolve(true),
  });
  const fullMessageBytes = messageWithoutToolsBytes +
    Buffer.byteLength(',"tools":', 'utf8') +
    Buffer.byteLength(JSON.stringify(tools), 'utf8');

  expect(tools).toHaveLength(1);
  expect(fullMessageBytes).toBeLessThan(128 * 1024);
});

it('keeps the first tool list for a message when a waiting turn is retried', async () => {
  const sentTurns = new Map<string, TurnDelivery>();
  const build = vi.fn(() => Promise.resolve([{ key: 'oc_4100837357', serverId: 'allow',
    connectionId: 'connection', definitions: [toolDefinition] }]));

  const first = await toolsForMessage(sentTurns, 'conversation', 'message', build);
  const retry = await toolsForMessage(sentTurns, 'conversation', 'message', build);

  expect(retry).toBe(first);
  expect(build).toHaveBeenCalledTimes(1);
});

it('offers tools only to bound personal memory-free turns', () => {
  expect(mayOfferTurnTools('personal', 'memory_free', true)).toBe(true);
  expect(mayOfferTurnTools('team', 'restricted', true)).toBe(false);
  expect(mayOfferTurnTools('personal', 'restricted', true)).toBe(false);
  expect(mayOfferTurnTools('personal', 'memory_free', false)).toBe(false);
});
