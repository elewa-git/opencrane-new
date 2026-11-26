import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Page } from 'playwright';
import { z } from 'zod';
import { childRequestStatusSchema } from '@opencrane/protocol';
import type { memberAuthorisation } from '@opencrane/authz';
import { postJourneyCommand, readJourneyApi } from './browser-api.ts';
import type { BudgetAssistant } from './budget-fixture.ts';

export interface SharedScreenshotChat {
  requester: Page;
  origin: string;
  assistant: BudgetAssistant;
  requesterId: string;
  readerId: string;
  authorisation: ReturnType<typeof memberAuthorisation>;
  until: (check: () => Promise<boolean>) => Promise<void>;
}

export async function createSharedScreenshotChat(options: SharedScreenshotChat) {
  const { requester, origin, assistant, requesterId, readerId, authorisation, until } = options;
  const parentId = randomUUID();
  const audience = [requesterId, readerId];
  const parent = { id: randomUUID(), conversationId: parentId, mode: 'group',
    participantIds: audience };
  const created = await postJourneyCommand(requester, origin, '/api/conversations', parent);
  assert.equal(created.status(), 200, 'Create a group chat for both people');
  async function groupCanRead() {
    const requesterAccess = await authorisation.conversation(requesterId, parentId, 'read');
    const readerAccess = await authorisation.conversation(readerId, parentId, 'read');
    return requesterAccess.allowed && readerAccess.allowed;
  }
  await until(groupCanRead);
  const sourceMessageId = randomUUID();
  const basePath = `/api/conversations/${parentId}`;
  const message = { id: sourceMessageId, text: 'Ask for help from the shared assistant.' };
  const posted = await postJourneyCommand(requester, origin, `${basePath}/messages`, message);
  assert.equal(posted.status(), 200, 'Post the group message that starts the assistant chat');
  const requestId = randomUUID();
  const reviewFields = { requestId, sourceMessageId, assistantId: assistant.assistantId,
    participantIds: audience };
  const reviewed = await postJourneyCommand(requester, origin, `${basePath}/child-review`,
    reviewFields);
  assert.equal(reviewed.status(), 200, 'Review the audience for the shared assistant chat');
  const { review } = z.object({ review: z.string() }).parse(await reviewed.json());
  const started = await postJourneyCommand(requester, origin, `${basePath}/children`,
    { requestId, sourceMessageId, review });
  assert.equal(started.status(), 200, 'Start the shared assistant chat');

  let conversationId: string | undefined;
  async function sharedChatCreated() {
    const url = `${origin}${basePath}/children/${requestId}`;
    const status = await readJourneyApi(requester, url);
    assert.equal(status.status(), 200);
    const child = childRequestStatusSchema.parse(await status.json());
    assert.notEqual(child.state, 'failed', 'The shared assistant chat opens');
    if (child.state !== 'queued' || !child.childConversationId) return false;
    conversationId = child.childConversationId;
    const readers = await authorisation.conversation(readerId, conversationId, 'read');
    return readers.allowed;
  }
  await until(sharedChatCreated);
  assert(conversationId);
  return conversationId;
}
