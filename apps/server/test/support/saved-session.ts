import { createHash } from 'node:crypto';
import type { ExecutionMode } from '../../src/chat/turns.ts';
import type { AgentSession } from '../../src/chat/bridge-conversation.ts';
import { summonFixture } from './child-summon.ts';

export type SavedSessionOptions = {
  conversationId: string;
  mode: ExecutionMode;
  payer?: string;
  child?: boolean;
};

export async function savedSessionFixture() {
  const fixture = await summonFixture();
  await fixture.append('team-other-payer', 'team.created',
    { teamId: 'other-payer', name: 'Other payer', createdBy: 'alice' });
  await fixture.append('team-other-payer', 'team.member_added',
    { teamId: 'other-payer', memberId: 'alice', addedBy: 'alice' });
  await fixture.append('computer-helper', 'computer.claimed',
    { assistantId: 'helper', computerId: 'computer', generation: 1, tokenId: 'token:fixture' }, false);
  await fixture.append('computer-helper', 'computer.ready',
    { assistantId: 'helper', computerId: 'computer', generation: 1, podUid: 'pod' }, false);
  return fixture;
}

export async function saveSession(fixture: Awaited<ReturnType<typeof savedSessionFixture>>,
  options: SavedSessionOptions) {
  const conversationId = options.conversationId;
  const base = { conversationId, assistantId: 'helper', createdBy: 'alice',
    mode: 'agent_session' as const, payingGroupId: options.payer ?? 'payer' };
  let created = base;
  if (options.child) {
    const parentId = `parent-${conversationId}`;
    const parent = await fixture.append(`conversation-${parentId}`, 'conversation.created',
      { conversationId: parentId, mode: 'group', createdBy: 'alice',
        participantIds: ['alice', 'bob'] });
    const parentPosition = await fixture.nats.store.head(`conversation-${parentId}`);
    const child = { ...base, contextKind: 'shared_child' as const,
      initialJoins: [{ participantId: 'alice', parentJoinEventId: parent.id,
        parentJoinPosition: parentPosition }],
      origin: { parentConversationId: parentId, sourceMessageId: 'source', sourcePosition: parentPosition + 1,
        intentEventId: 'old-intent', intentPosition: parentPosition + 2, requestId: 'request',
        firstInputId: `input-${conversationId}` } };
    created = child;
  }

  const event = await fixture.append(`conversation-${conversationId}`, 'conversation.created',
    created);
  const conversation: AgentSession = { ...created, assistantKind: 'team', createdAt: event.time };
  return conversation;
}

export async function saveInput(fixture: Awaited<ReturnType<typeof savedSessionFixture>>,
  conversationId: string, mode: ExecutionMode) {
  const encrypted = ({ utterance: 'Saved question' });
  const data = { conversationId, authorId: 'alice', authorKind: 'human', contentType: 'text',
    ...encrypted, ...(mode === 'memory_free' ? { executionMode: mode } : {}) };
  return fixture.append(`conversation-${conversationId}`, 'message.posted', data, false);
}

export async function saveUpload(fixture: Awaited<ReturnType<typeof savedSessionFixture>>,
  conversationId: string) {
  const bytes = Buffer.from('Saved clean upload canary');
  const digest = createHash('sha256');
  digest.update(bytes);
  const sha256 = digest.digest('hex');
  const file = { conversationId, fileId: `file-${conversationId}`, uploadedBy: 'alice',
    name: 'notes.txt', mime: 'text/plain', size: bytes.length, sha256,
    objectKey: `test/${conversationId}/notes` };
  await fixture.append(`conversation-${conversationId}`, 'file.uploaded', file, false);
  return { file, bytes };
}
