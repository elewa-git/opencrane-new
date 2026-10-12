import { expect, it } from 'vitest';
import { parseTurn } from '../src/turn-frame.ts';

const frame = { id: 'turn', conversationId: 'chat', assistantId: 'assistant',
  text: 'Use a tool', token: 'token', expiresAt: Date.now() + 60_000 };
const server = { key: 'oc_0123456789', serverId: 'fixture', connectionId: 'installed',
  modes: { write: 'allow' as const },
  serverInfo: { name: 'Fixture', version: '1' }, definitions: ['{"name":"write"}'] };

function parsesBoundedTools() {
  expect(parseTurn({ ...frame, tools: [server] })).toMatchObject({ tools: [server] });
  const ask = { ...server, modes: { write: 'ask' } };
  expect(parseTurn({ ...frame, tools: [ask] }).tools).toEqual([ask]);
  expect(parseTurn(frame)).not.toHaveProperty('tools');
  const invalidLists = [

    [{ ...server, modes: { write: 'block' } }],
    [{ ...server, modes: undefined }],
    [{ ...server, key: 'fixture' }], [{ ...server, serverId: 'bad/id' }],
    [{ ...server, connectionId: 'x'.repeat(201) }],
    [{ ...server, discoverResult: '{}' }], [{ ...server, unexpected: true }],
    [{ ...server, serverInfo: { name: 'Fixture', version: '1', instructions: 'private' } }],
    [{ ...server, definitions: [12] }], Array(21).fill(server),
    [{ ...server, definitions: ['x'.repeat(48 * 1024)] }],
  ];
  for (const tools of invalidLists) {
    expect(() => parseTurn({ ...frame, tools })).toThrow();
  }
  const unicodeServer = { ...server, definitions: ['界'.repeat(17 * 1024)] };
  expect(() => parseTurn({ ...frame, tools: [unicodeServer] })).toThrow();
}
it('accepts only a strict tool list within the server and UTF-8 byte limits', parsesBoundedTools);

function acceptsOnlyTheSharedClassOnRestrictedTurns() {
  const shared = parseTurn({ ...frame, executionMode: 'restricted',
    contextClass: 'shared_only' });
  expect(shared.contextClass).toBe('shared_only');
  expect(() => parseTurn({ ...frame, contextClass: 'shared_only' })).toThrow();
  expect(() => parseTurn({ ...frame, executionMode: 'memory_free',
    contextClass: 'shared_only' })).toThrow();
}
it('accepts the shared-only class only on restricted turns',
  acceptsOnlyTheSharedClassOnRestrictedTurns);
