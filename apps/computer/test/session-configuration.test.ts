import { expect, it } from 'vitest';
import { computerSessionConfiguration } from '../src/codex-config.ts';
import { parseTurn } from '../src/turn-frame.ts';

function derivesSharedRestrictions() {
  const turn = parseTurn({ id: 'turn', conversationId: 'chat', assistantId: 'assistant',
    text: 'Hello', token: 'pass', expiresAt: Date.now() + 60_000,
    executionMode: 'restricted', sharingClass: 'shared_only',
    configuration: { process: 'persistent_thread', tools: 'reviewed_mcp', attachments: true } });
  const configuration = computerSessionConfiguration(turn);
  expect(configuration).toMatchObject({ kind: 'shared_child', process: 'fresh_isolated',
    context: 'shared_exchanges', tools: 'none', attachments: false, localTools: false });
}
it('derives shared restrictions from turn facts and ignores a supplied configuration',
  derivesSharedRestrictions);

function keepsPrivateAndPersistentModesSeparate() {
  expect(computerSessionConfiguration({ executionMode: 'restricted' })).toMatchObject({
    process: 'fresh_isolated', context: 'own_exchanges', attachments: false, localTools: false,
  });
  expect(computerSessionConfiguration({ executionMode: 'memory_free' })).toMatchObject({
    process: 'persistent_thread', context: 'thread', attachments: true, localTools: true,
  });
  expect(computerSessionConfiguration({ executionMode: 'restricted', senderAttemptId: 'attempt' }))
    .toMatchObject({ kind: 'routine', context: 'routine_input', tools: 'reviewed_mcp',
      process: 'fresh_isolated' });
}
it('keeps private, routine and persistent turn settings separate',
  keepsPrivateAndPersistentModesSeparate);
