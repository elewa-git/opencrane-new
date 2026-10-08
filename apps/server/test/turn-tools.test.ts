import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { envelope } from '@opencrane/models';
import type { StoredEvent } from '@opencrane/event-store';
import { fileUploadedDataSchema } from '@opencrane/events';
import { buildTurnTools, mayOfferTurnTools, toolsForMessage,
  type TurnDelivery, type TurnToolServerState } from '../src/chat/turn-tools.ts';
import { turnMessage, type AgentSession, type WatchOptions } from '../src/chat/bridge-conversation.ts';
import { agentSessionData } from '../src/chat/reports.ts';

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
    ['no-cost', serverState('no-cost', { policyTools: [{ name: 'read',
      revision: 'a'.repeat(64), reviewed: true, mode: 'allow' }] })],
    ['revision-changed', serverState('revision-changed', { policyTools: [{ name: 'read',
      revision: 'b'.repeat(64), reviewed: true, costCents: 0, mode: 'allow' }] })],
    ['credentials', serverState('credentials', { accountMode: 'personal' })],
    ['unpublished', serverState('unpublished', { published: false })],
  ]);
  const canUse = vi.fn((serverId: string, kind: 'person' | 'assistant') =>
    Promise.resolve(serverId !== 'revoked' &&
      !(serverId === 'assistant-denied' && kind === 'assistant')));
  states.set('revoked', serverState('revoked'));
  states.set('assistant-denied', serverState('assistant-denied'));
  states.set('person-denied', serverState('person-denied'));
  canUse.mockImplementation((serverId, kind) => Promise.resolve(
    serverId !== 'revoked' && !(serverId === 'person-denied' && kind === 'person') &&
    !(serverId === 'assistant-denied' && kind === 'assistant')));
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
    definitions: [toolDefinition], modes: { read: 'allow' as const },
  });
  expect(JSON.stringify(tools)).not.toContain('discoverResult');
  expect(JSON.stringify(tools)).not.toContain('review text');
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

it('fits the largest ordinary turn and attachments below the socket limit', async () => {
  const uploadRows: StoredEvent[] = [];
  const uploads = [];
  for (let index = 0; index < 100; index += 1) {
    const event = envelope('test', 'conversation-chat', 'file.uploaded', {
      conversationId: 'chat', fileId: `file-${index}`, uploadedBy: 'person',
      name: 'a'.repeat(120), size: 1, sha256: 'a'.repeat(64), mime: 'text/plain',
      objectKey: `chat/file-${index}`,
    });
    const row: StoredEvent = { sequence: index + 1, event };
    uploadRows.push(row);
    uploads.push(fileUploadedDataSchema.parse(event.data));
  }
  const messageEvent = envelope('test', 'conversation-chat', 'message.posted', {
    conversationId: 'chat', authorId: 'person', authorKind: 'human',
    ciphertext: 'a'.repeat(16), keyId: 'key:unused', contentType: 'text',
  });
  const message: StoredEvent = { sequence: 101, event: messageEvent };
  const rows = uploadRows;
  // turnMessage uses only silo and decryption here; the large text makes this real byte count useful.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Other WatchOptions fields are unused.
  const options = {
    silo: 'test',
    keys: { decrypt: () => '界'.repeat(32_000) },
  } as unknown as WatchOptions;
  const conversationDetails = agentSessionData({
    conversationId: 'chat', assistantId: 'assistant', createdBy: 'person',
    mode: 'agent_session',
  });
  const conversation: AgentSession = {
    ...conversationDetails,
    conversationId: 'chat',
    createdAt: new Date().toISOString(),
    assistantKind: 'personal',
  };
  const turn = turnMessage(options, conversation, rows, uploads, message, 'memory_free');
  const baseMessageBytes = Buffer.byteLength(JSON.stringify(turn), 'utf8');
  const rowsForTools = Array.from({ length: 21 }, (_, index) => ({
    serverId: `server-${index}`,
  }));

  const tools = await buildTurnTools({
    rows: rowsForTools,
    requesterId: 'person',
    assistantId: 'assistant',
    baseMessageBytes,
    readServer: serverId => Promise.resolve(serverState(serverId, {
      discoveryTools: [{ name: 'read', revision: 'a'.repeat(64), definition: JSON.stringify({
        name: 'read', description: 'x'.repeat(1_300),
      }) }],
    })),
    canUse: () => Promise.resolve(true),
  });
  const fullTurn = { ...turn, tools };
  const fullTurnBytes = Buffer.byteLength(JSON.stringify(fullTurn), 'utf8');

  expect(tools.length).toBeGreaterThan(0);
  expect(tools.length).toBeLessThan(20);
  expect(fullTurnBytes).toBeLessThan(120 * 1024);
  expect(fullTurnBytes).toBeLessThan(128 * 1024);

  const nextServerId = `server-${tools.length}`;
  const nextServer = serverState(nextServerId, {
    discoveryTools: [{ name: 'read', revision: 'a'.repeat(64), definition: JSON.stringify({
      name: 'read', description: 'x'.repeat(1_300),
    }) }],
  });
  const nextKey = `oc_${createHash('sha256').update(nextServerId).digest('hex').slice(0, 10)}`;
  const nextEntry = {
    key: nextKey,
    serverId: nextServerId,
    connectionId: nextServer.connectionId,
    serverInfo: nextServer.serverInfo,
    definitions: [nextServer.discoveryTools[0]!.definition],
  };
  expect(Buffer.byteLength(JSON.stringify({ ...turn, tools: [...tools, nextEntry] }), 'utf8'))
    .toBeGreaterThan(120 * 1024);
});

it('keeps the first tool list for a message when a waiting turn is retried', async () => {
  const sentTurns = new Map<string, TurnDelivery>();
  const build = vi.fn(() => Promise.resolve([{ key: 'oc_4100837357', serverId: 'allow',
    connectionId: 'connection', definitions: [toolDefinition], modes: { read: 'allow' as const } }]));

  const first = await toolsForMessage(sentTurns, 'conversation', 'message', build);
  const retry = await toolsForMessage(sentTurns, 'conversation', 'message', build);

  expect(retry).toBe(first);
  expect(build).toHaveBeenCalledTimes(1);
});

it('offers tools only to bound personal memory-free turns', () => {
  expect(mayOfferTurnTools('personal', 'memory_free', true)).toBe(true);
  expect(mayOfferTurnTools('team', 'restricted', true)).toBe(false);
  expect(mayOfferTurnTools('team', 'memory_free', true)).toBe(false);
  expect(mayOfferTurnTools('personal', 'restricted', true)).toBe(false);
  expect(mayOfferTurnTools('personal', 'memory_free', false)).toBe(false);
});

it('offers no more than 20 eligible servers', async () => {
  const rows = Array.from({ length: 21 }, (_, index) => ({ serverId: `server-${index}` }));

  const tools = await buildTurnTools({
    rows,
    requesterId: 'person',
    assistantId: 'assistant',
    baseMessageBytes: 100,
    readServer: serverId => Promise.resolve(serverState(serverId)),
    canUse: () => Promise.resolve(true),
  });

  expect(tools).toHaveLength(20);
});

it('leaves out entries the computer would refuse and repeated server keys', async () => {
  const rows = [
    { serverId: 'valid' },
    { serverId: 'bad:id' },
    { serverId: 'bad-connection' },
    { serverId: 'long-info' },
    { serverId: 'long-definition' },
    { serverId: 'valid' },
  ];

  const tools = await buildTurnTools({
    rows,
    requesterId: 'person',
    assistantId: 'assistant',
    baseMessageBytes: 100,
    readServer: serverId => {
      if (serverId === 'bad:id') return Promise.resolve(serverState(serverId));
      if (serverId === 'bad-connection') {
        return Promise.resolve(serverState(serverId, { connectionId: 'conn:1' }));
      }
      if (serverId === 'long-info') {
        return Promise.resolve(serverState(serverId, {
          serverInfo: { name: 'x'.repeat(201), version: '1' },
        }));
      }
      if (serverId === 'long-definition') {
        return Promise.resolve(serverState(serverId, {
          discoveryTools: [{ name: 'read', revision: 'a'.repeat(64),
            definition: 'x'.repeat(32_769) }],
        }));
      }
      return Promise.resolve(serverState(serverId));
    },
    canUse: () => Promise.resolve(true),
  });

  expect(tools).toHaveLength(1);
  expect(tools[0]).toMatchObject({ serverId: 'valid' });
});
