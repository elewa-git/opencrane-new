import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import { childRequests } from '@opencrane/projections';
import { requestChild, createRequestedChild } from '../src/chat/child-requests.ts';
import { recordChildStartFailure } from '../src/chat/child-failure.ts';
import { chatHistory } from '../src/chat/commands.ts';
import { summonFixture } from './support/child-summon.ts';

let context: Awaited<ReturnType<typeof summonFixture>>;
async function setup() {
  context = await summonFixture();
  await context.runner.initialise(childRequests);
}
async function cleanup() {
  await context.close();
}
beforeAll(setup, 60_000);
afterAll(cleanup);
afterEach(vi.restoreAllMocks);

async function failedRequest(created = false) {
  const input = await context.parent();
  const command = { ...input, payingGroupId: 'payer' };
  const saved = await requestChild(context.options, 'alice', command);
  if (created) {
    const child = await createRequestedChild(context.options, 'alice', command);
    await context.auth.handler.handle(child.event, context.db);
  }
  const intent = await context.intent(input.conversationId);
  const stage = created ? 'first_input' : 'create';
  await recordChildStartFailure(context.options, saved.event.id, intent, stage, 'access_refused');
  const rows = await chatHistory(context.nats.store, 'test', input.conversationId);
  const failureEventId = rows.at(-1)!.event.id;
  const payload = { retryId: `retry-${input.requestId}`, failureEventId };
  const path = `children/${input.requestId}/retry`;
  return { input, intent, saved, payload, path };
}
async function acceptsSavedFailure() {
  const request = await failedRequest();
  const response = await context.request(request.input.conversationId, request.path, request.payload);
  expect(response.statusCode, response.body).toBe(202);
  expect(response.json()).toMatchObject({ requestId: request.input.requestId,
    retryId: request.payload.retryId, failureEventId: request.payload.failureEventId, attempt: 2 });
  const repeated = await context.request(request.input.conversationId, request.path, request.payload);
  expect(repeated.body).toBe(response.body);
  expect(response.body).not.toContain(request.intent.childConversationId);
  expect(response.body).not.toContain('canary');
}
it('saves a requester retry and returns the same receipt', acceptsSavedFailure);
