import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { APIResponse, Page } from 'playwright';
import { z } from 'zod';
import { childRequestStatusSchema } from '@opencrane/protocol';
import type { memberAuthorisation } from '@opencrane/authz';
import { postJourneyCommand, readJourneyApi } from './browser-api.ts';
import type { BudgetAssistant } from './budget-fixture.ts';

export interface SharedScreenshotChat {
  requester: Pick<Page, 'request'>;
  reader: Pick<Page, 'request'>;
  origin: string;
  assistant: BudgetAssistant;
  requesterId: string;
  readerId: string;
  authorisation: Pick<ReturnType<typeof memberAuthorisation>, 'conversation'>;
  until: (check: () => Promise<boolean>) => Promise<void>;
}

export async function createSharedScreenshotChat(options: SharedScreenshotChat) {
  const { requester, reader, origin, assistant, requesterId, readerId, authorisation, until } = options;
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
  await verifyStartReply(started, requestId);

  let conversationId: string | undefined;
  async function sharedChatCreated() {
    const url = `${origin}${basePath}/children/${requestId}`;
    const status = await readJourneyApi(requester, url);
    assert.equal(status.status(), 200);
    const child = childRequestStatusSchema.parse(await status.json());
    assert.notEqual(child.state, 'failed', 'The shared assistant chat opens');
    if (child.state !== 'queued') return false;
    assert.equal(child.requestId, requestId);
    if (!child.childConversationId) return false;
    conversationId = child.childConversationId;
    const permission = await authorisation.conversation(readerId, conversationId, 'read');
    if (!permission.allowed) return false;
    const messages = `${origin}/api/conversations/${conversationId}/messages`;
    const history = await readJourneyApi(reader, messages);
    return history.status() === 200;
  }
  await until(sharedChatCreated);
  assert(conversationId);
  return conversationId;
}

async function verifyStartReply(response: APIResponse, requestId: string) {
  if (response.status() === 425) {
    // Follow the saved request while permission for its first input is still applying.
    const applying = z.object({ status: z.literal('access_applying') });
    applying.parse(await response.json());
    return;
  }
  assert.equal(response.status(), 202, 'Start the shared assistant chat');
  const queued = z.object({ state: z.literal('queued'), requestId: z.literal(requestId) });
  queued.parse(await response.json());
}
