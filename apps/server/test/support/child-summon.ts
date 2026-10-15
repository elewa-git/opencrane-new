import { generateKeyPairSync } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { tokenIssuer } from '@opencrane/auth';
import { childRequestedDataSchema } from '@opencrane/events';
import { chatHistory } from '../../src/chat/commands.ts';
import { buildServer } from '../../src/server.ts';
import { childFixture } from './child-fixture.ts';

export async function summonFixture() {
  const context = await childFixture();
  for (const teamId of ['owners', 'payer']) {
    await context.append(`team-${teamId}`, 'team.created',
      { teamId, name: teamId, createdBy: 'alice' });
    await context.append(`team-${teamId}`, 'team.member_added',
      { teamId, memberId: 'alice', addedBy: 'alice' });
  }
  for (const assistantId of ['helper', 'other-helper']) {
    await context.append(`assistant-${assistantId}`, 'assistant.created',
      { assistantId, ownerId: 'owners', kind: 'team', payingGroupId: 'payer' });
  }
  const keyOptions = { namedCurve: 'P-256',
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' } } as const;
  const key = generateKeyPairSync('ec', keyOptions);
  const privateKeyPath = `${dirname(context.nats.env().NATS_CA_FILE)}/signing.pem`;
  await writeFile(privateKeyPath, key.privateKey, { mode: 0o600 });
  const tokens = await tokenIssuer({ privateKeyPath, issuer: 'https://child.test/' });
  let app = context.app;
  let counter = 0;
  async function parent(mode = 'group', authorId = 'alice') {
    const conversationId = `parent-${++counter}`;
    let data: object = { conversationId, mode, createdBy: 'alice',
      participantIds: ['alice', 'bob'] };
    if (mode === 'agent_session') {
      data = { conversationId, mode, createdBy: 'alice', assistantId: 'helper' };
    }
    await context.append(`conversation-${conversationId}`, 'conversation.created', data);
    context.keys.provision('test', conversationId);
    const encrypted = context.keys.encrypt('test', conversationId, '@Assistant source canary');
    const source = await context.append(`conversation-${conversationId}`, 'message.posted',
      { conversationId, authorId, authorKind: 'human', contentType: 'text', ...encrypted }, false);
    return { conversationId, requestId: `request-${counter}`, sourceMessageId: source.id,
      assistantId: 'helper', participantIds: ['alice', 'bob'] };
  }
  function request(parent: string, path: string, payload?: object, memberId = 'alice') {
    const options = { method: payload ? 'POST' as const : 'GET' as const,
      url: `/api/conversations/${parent}/${path}`, headers: context.headers(memberId),
      ...(payload === undefined ? {} : { payload }) };
    return app.inject(options);
  }
  async function intent(parent: string) {
    const rows = await chatHistory(context.nats.store, 'test', parent);
    function isIntent(row: typeof rows[number]) {
      return row.event.type === 'conversation.child_requested';
    }
    return childRequestedDataSchema.parse(rows.find(isIntent)?.event.data);
  }
  async function restart() {
    await app.close();
    app = buildServer(context.config, { chat: context.options });
  }
  async function close() {
    await app.close();
    await context.close();
  }
  return { ...context, tokens, parent, request, intent, restart, close };
}
