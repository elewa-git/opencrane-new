import { childStartFailure } from './child-failure.ts';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { AuthConfig } from '@opencrane/auth';
import { chatIdSchema, childRequestedDataSchema, type ChildRequest } from '@opencrane/events';
import { childReviewInputSchema, childStartInputSchema, childRequestStatusSchema }
  from '@opencrane/protocol';
import { AuthorityApplying, isAuthorityChanged } from '@opencrane/models';
import { requireMember, MemberRefusal } from '../members/guard.ts';
import { chatAccess, ChatAccessApplying, isChatRefused, type ChatOptions } from './access.ts';
import { chatHistory } from './commands.ts';
import { reviewChildRequest, requestChild, createRequestedChild, addChildFirstInput,
  ChildRequestRefused, ChildRequestClosed, ChildRequestChanged, ChildRequestFailed }
  from './child-requests.ts';

const bindingSchema = z.strictObject({ silo: chatIdSchema, data: childRequestedDataSchema,
  expiresAt: z.int().positive() });
function signature(secret: string, encoded: string) {
  const hmac = createHmac('sha256', secret);
  hmac.update(`child-review:${encoded}`);
  return hmac.digest();
}
function verify(secret: string, review: string) {
  try {
    const [encoded, supplied, extra] = review.split('.');
    if (!encoded || !supplied || extra !== undefined) throw new ChildRequestRefused();
    const expected = signature(secret, encoded);
    const bytes = Buffer.from(supplied, 'base64url');
    if (bytes.length !== expected.length || !timingSafeEqual(bytes, expected)) {
      throw new ChildRequestRefused();
    }
    const value: unknown = JSON.parse(Buffer.from(encoded, 'base64url').toString());
    return bindingSchema.parse(value);
  } catch {
    throw new ChildRequestRefused();
  }
}
async function requireGroup(options: ChatOptions, conversationId: string) {
  const schema = z.object({ mode: z.literal('group') });
  for await (const row of options.store.readStream(`conversation-${conversationId}`, 1,
    performance.now() + 10_000)) {
    if (row.event.silo !== options.silo || row.event.type !== 'conversation.created' ||
        !schema.safeParse(row.event.data).success) throw new ChildRequestRefused();
    return;
  }
  throw new ChildRequestRefused();
}
async function payer(options: ChatOptions, assistantId: string) {
  const schema = z.object({ kind: z.literal('team'), payingGroupId: chatIdSchema });
  for await (const row of options.store.readStream(`assistant-${assistantId}`, 1,
    performance.now() + 10_000)) {
    const parsed = schema.safeParse(row.event.data);
    if (row.event.silo !== options.silo || row.event.type !== 'assistant.created' ||
        !parsed.success) throw new ChildRequestRefused();
    return parsed.data.payingGroupId;
  }
  throw new ChildRequestRefused();
}
async function review(options: ChatOptions, memberId: string, conversationId: string,
  value: unknown, secret: string) {
  const input = childReviewInputSchema.parse(value);
  const payingGroupId = await payer(options, input.assistantId);
  const command = { ...input, conversationId, payingGroupId };
  const data = await reviewChildRequest(options, memberId, command);
  const expiresAt = Date.now() + 600_000;
  const encoded = Buffer.from(JSON.stringify({ silo: options.silo, data, expiresAt }))
    .toString('base64url');
  const review = `${encoded}.${signature(secret, encoded).toString('base64url')}`;
  return { ...input, payingGroupId, review, expiresAt };
}
function participantId(join: ChildRequest['initialJoins'][number]) {
  return join.participantId;
}
async function start(options: ChatOptions, memberId: string, conversationId: string,
  value: unknown, secret: string) {
  const input = childStartInputSchema.parse(value);
  const binding = verify(secret, input.review);
  const data = binding.data;
  if (binding.silo !== options.silo || data.createdBy !== memberId ||
      data.conversationId !== conversationId) throw new ChildRequestRefused();
  if (data.requestId !== input.requestId || data.sourceMessageId !== input.sourceMessageId) {
    throw new ChildRequestChanged();
  }
  const rows = await chatHistory(options.store, options.silo, conversationId);
  let saved = false;
  for (const row of rows) {
    if (row.event.type !== 'conversation.child_requested') continue;
    const previous = childRequestedDataSchema.parse(row.event.data);
    if (previous.sourceMessageId === input.sourceMessageId) saved = true;
  }
  if (!saved && binding.expiresAt <= Date.now()) throw new ChildRequestRefused();
  const participantIds = data.initialJoins.map(participantId);
  const fields = { conversationId, requestId: input.requestId, sourceMessageId: input.sourceMessageId,
    assistantId: data.assistantId,
    payingGroupId: data.payingGroupId, allowanceBoundCents: data.allowanceBoundCents, participantIds };
  const intent = await retryRequest(options, memberId, fields, data);
  const receipt = childRequestedDataSchema.parse(intent.event.data);
  await retryStage(createRequestedChild, options, memberId, fields);
  await retryStage(addChildFirstInput, options, memberId, fields);
  return { requestId: receipt.requestId, state: 'queued' as const };
}
async function retryRequest(options: ChatOptions, memberId: string, fields: unknown,
  expected: ChildRequest) {
  async function append() {
    return requestChild(options, memberId, fields, expected);
  }
  return retryStage(append, options, memberId, fields);
}
async function retryStage(operation: typeof createRequestedChild, options: ChatOptions,
  memberId: string, fields: unknown) {
  try {
    return await operation(options, memberId, fields);
  } catch (error) {
    if (!(error instanceof ChildRequestChanged)) throw error;
    // Reload once after a conditional append loses a race. Verify saved values again.
    return operation(options, memberId, fields);
  }
}
async function status(options: ChatOptions, memberId: string, conversationId: string,
  requestId: string) {
  const rows = await chatHistory(options.store, options.silo, conversationId);
  const access = await chatAccess(options, { memberId, conversationId });
  for (const row of rows) {
    if (row.event.type !== 'conversation.child_requested') continue;
    const data = childRequestedDataSchema.parse(row.event.data);
    if (data.requestId !== requestId || data.createdBy !== memberId ||
        data.sourcePosition < access.historyPosition) continue;
    const failed = childStartFailure(rows, row.event.id);
    if (failed) {
      const { stage, reason, attempt } = failed.data;
      return childRequestStatusSchema.parse({ state: 'failed', requestId,
        stage, reason, attempt, failureEventId: failed.id });
    }
    const response: z.infer<typeof childRequestStatusSchema> = { requestId, state: 'queued' };
    for await (const child of options.store.readStream(`conversation-${data.childConversationId}`,
      1, performance.now() + 10_000)) {
      if (child.event.silo !== options.silo || child.event.type !== 'conversation.created') {
        throw new Error('Child creation unavailable');
      }
      response.childConversationId = data.childConversationId;
      break;
    }
    return childRequestStatusSchema.parse(response);
  }
  return childRequestStatusSchema.parse({ state: 'unknown' });
}
export function registerChildRoutes(app: FastifyInstance, config: AuthConfig, options?: ChatOptions) {
  const base = '/api/conversations/:conversationId';
  function requestLog() {
    return { operation: 'child-request' };
  }
  function invalidBody(_error: unknown, _request: FastifyRequest, reply: FastifyReply) {
    reply.header('cache-control', 'no-store');
    return reply.code(400).send({ status: 'refused' });
  }
  const routeOptions = { bodyLimit: 160_000, logSerializers: { req: requestLog },
    errorHandler: invalidBody };
  app.post(`${base}/child-review`, routeOptions, handler);
  app.post(`${base}/children`, routeOptions, handler);
  app.get(`${base}/children/:requestId`, routeOptions, handler);
  async function handler(request: FastifyRequest, reply: FastifyReply) {
    reply.header('cache-control', 'no-store');
    const reviewing = request.routeOptions.url?.endsWith('/child-review');
    try {
      const params = z.object({ conversationId: chatIdSchema,
        requestId: chatIdSchema.optional() }).parse(request.params);
      const context = await requireMember(request, reply, config, options,
        { write: request.method === 'POST' });
      await requireGroup(context.options, params.conversationId);
      if (params.requestId) {
        return reply.send(await status(context.options, context.memberId,
          params.conversationId, params.requestId));
      }
      const operation = reviewing ? review : start;
      const response = await operation(context.options, context.memberId, params.conversationId,
        request.body, config.cookieSecret);
      return reply.code(reviewing ? 200 : 202).send(response);
    } catch (error) {
      return failure(reply, error, reviewing === true);
    }
  }
}

function failure(reply: FastifyReply, error: unknown, reviewing: boolean) {
  if (error instanceof MemberRefusal) {
    return reply.code(error.statusCode).send({ status: error.status });
  }
  if (error instanceof ChildRequestFailed) return reply.code(409).send({ status: 'conflict' });
  if (error instanceof ChildRequestClosed) {
    return reply.code(reviewing ? 403 : 409).send({ status: reviewing ? 'refused' : 'conflict' });
  }
  if (error instanceof ChildRequestRefused || isChatRefused(error)) {
    return reply.code(403).send({ status: 'refused' });
  }
  if (error instanceof ChildRequestChanged) return reply.code(409).send({ status: 'conflict' });
  if (isAuthorityChanged(error)) return reply.code(409).send({ status: 'review_stale' });
  if (error instanceof ChatAccessApplying || error instanceof AuthorityApplying) {
    return reply.code(425).send({ status: 'access_applying' });
  }
  if (error instanceof z.ZodError) return reply.code(400).send({ status: 'refused' });
  return reply.code(503).send({ status: 'unavailable' });
}
