import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { AuthConfig } from '@opencrane/auth';
import { readEventAt, type StoredEvent } from '@opencrane/event-store';
import { childResultPublishedDataSchema, chatIdSchema } from '@opencrane/events';
import { authorityFence, isAuthorityChanged } from '@opencrane/models';
import { requireMember, MemberRefusal } from '../members/guard.ts';
import { chatAccess, conversationParticipation, isChatRefused, ChatRefused,
  type ChatOptions } from './access.ts';
import { inheritedChildSubjects } from './child-access.ts';
import { chatHistory } from './commands.ts';
import { participationClosed } from './participation.ts';

const textSchema = z.string().trim().min(1).max(32_000);
const reviewInput = z.strictObject({ publicationKind: z.literal('final'),
  resultEventId: chatIdSchema, text: textSchema, fileIds: z.array(chatIdSchema).optional() });
const publishInput = z.strictObject({ id: chatIdSchema, review: z.string().max(8000),
  text: textSchema });
const bindingSchema = reviewInput.omit({ text: true, fileIds: true }).extend({
  silo: chatIdSchema, publishedBy: chatIdSchema, parentConversationId: chatIdSchema,
  childConversationId: chatIdSchema, resultPosition: z.int().positive(), turnId: chatIdSchema,
  textDigest: z.string(), accessPosition: z.int().nonnegative(), expiresAt: z.int().positive(),
});
type Binding = z.infer<typeof bindingSchema>;
class PublicationConflict extends Error {}
function digest(value: string) {
  const hash = createHash('sha256');
  hash.update(value);
  return hash.digest('hex');
}
function signature(secret: string, encoded: string) {
  const hmac = createHmac('sha256', secret);
  hmac.update(`child-publication:${encoded}`);
  return hmac.digest();
}
function sign(secret: string, binding: Binding) {
  const encoded = Buffer.from(JSON.stringify(binding)).toString('base64url');
  return `${encoded}.${signature(secret, encoded).toString('base64url')}`;
}
function verify(secret: string, review: string) {
  try {
    const [encoded, supplied, extra] = review.split('.');
    if (!encoded || !supplied || extra !== undefined) throw new ChatRefused();
    const expected = signature(secret, encoded);
    const bytes = Buffer.from(supplied, 'base64url');
    if (bytes.length !== expected.length || !timingSafeEqual(bytes, expected)) {
      throw new ChatRefused();
    }
    const value: unknown = JSON.parse(Buffer.from(encoded, 'base64url').toString());
    return bindingSchema.parse(value);
  } catch {
    throw new ChatRefused();
  }
}
async function load(options: ChatOptions, memberId: string, child: string) {
  const access = await conversationParticipation(options, memberId, child);
  if (!('contextKind' in access.created)) throw new ChatRefused();
  const origin = access.created.origin;
  await chatAccess(options, { memberId, conversationId: origin.parentConversationId });
  // Load both histories before opening the short check of who may publish.
  const parentRows = await chatHistory(options.store, options.silo, origin.parentConversationId);
  const childRows = await chatHistory(options.store, options.silo, child);
  return { access, origin, parentRows, childRows, child };
}
type Loaded = Awaited<ReturnType<typeof load>>;
async function check(options: ChatOptions, memberId: string, loaded: Loaded,
  deadline = performance.now() + 2000, retry = false) {
  await chatAccess(options, { memberId, conversationId: loaded.child, deadline });
  const parent = await chatAccess(options, { memberId,
    conversationId: loaded.origin.parentConversationId, relation: retry ? 'read' : 'post', deadline });
  if (retry) return parent;
  const source = find(loaded.parentRows, loaded.origin.sourceMessageId);
  if (!source || source.sequence !== loaded.origin.sourcePosition ||
      source.event.type !== 'message.posted' || source.sequence < parent.historyPosition) {
    throw new ChatRefused();
  }
  if (loaded.parentRows.some(isClosed) || await participationClosed(options.store, options.silo,
    loaded.origin.parentConversationId, deadline)) throw new PublicationConflict('parent_closed');
  return parent;
}
function isClosed(row: StoredEvent) {
  return row.event.type === 'conversation.closed';
}
function find(rows: StoredEvent[], id: string) {
  function matches(row: StoredEvent) {
    return row.event.id === id;
  }
  return rows.find(matches);
}
function result(loaded: Loaded, resultEventId: string) {
  const selected = find(loaded.childRows, resultEventId);
  if (!selected || selected.event.type !== 'agent.message_completed' ||
      selected.sequence < loaded.access.historyPosition) {
    throw new PublicationConflict('review_stale');
  }
  const fields = z.object({ turnId: chatIdSchema }).parse(selected.event.data);
  let shared = false;
  let completed = false;
  for (const row of loaded.childRows) {
    const data = z.record(z.string(), z.unknown()).parse(row.event.data);
    if (data['turnId'] !== fields.turnId) continue;
    if (row.event.type === 'agent.output_lost' || row.event.type === 'agent.turn_failed') {
      throw new PublicationConflict('review_stale');
    }
    if (row.event.type === 'agent.turn_completed') completed = true;
    if (row.event.type === 'agent.turn_started') {
      shared = data['sharingClass'] === 'shared_only' && data['executionMode'] === 'restricted';
    }
  }
  if (!shared || !completed) throw new PublicationConflict('review_stale');
  return { resultPosition: selected.sequence, turnId: fields.turnId };
}
async function review(options: ChatOptions, memberId: string, loaded: Loaded,
  value: unknown, secret: string) {
  const input = reviewInput.parse(value);
  const parent = await check(options, memberId, loaded);
  if (input.fileIds !== undefined) throw new PublicationConflict('files_unavailable');
  const selected = result(loaded, input.resultEventId);
  const expiresAt = Date.now() + 600_000;
  const binding: Binding = { silo: options.silo, publishedBy: memberId,
    parentConversationId: loaded.origin.parentConversationId, childConversationId: loaded.child,
    publicationKind: input.publicationKind, resultEventId: input.resultEventId, ...selected,
    textDigest: digest(input.text), accessPosition: parent.accessPosition, expiresAt };
  return { status: 'reviewed', text: input.text, publicationKind: input.publicationKind,
    parentConversationId: binding.parentConversationId, audience: parent.participantIds,
    publishedBy: memberId, review: sign(secret, binding), expiresAt };
}
function verifySaved(row: StoredEvent, options: ChatOptions, binding: Binding,
  input: z.infer<typeof publishInput>) {
  const event = row.event;
  const parsed = childResultPublishedDataSchema.safeParse(event.data);
  if (!parsed.success || event.id !== input.id || event.silo !== options.silo ||
      event.subject !== `conversation-${binding.parentConversationId}` ||
      event.type !== 'conversation.child_result_published' ||
      event.principal?.kind !== 'human' || event.principal.id !== binding.publishedBy ||
      parsed.data.publishedBy !== binding.publishedBy ||
      parsed.data.conversationId !== binding.parentConversationId ||
      parsed.data.childConversationId !== binding.childConversationId ||
      parsed.data.reviewDigest !== digest(input.review) ||
      options.keys.decrypt(options.silo, binding.parentConversationId, parsed.data) !== input.text) {
    throw new PublicationConflict('review_stale');
  }
  return { status: 'appended', sequence: row.sequence };
}
function currentResult(loaded: Loaded, binding: Binding, text: string) {
  const selected = result(loaded, binding.resultEventId);
  if (binding.expiresAt <= Date.now() || binding.textDigest !== digest(text) ||
      binding.resultPosition !== selected.resultPosition || binding.turnId !== selected.turnId) {
    throw new PublicationConflict('review_stale');
  }
  return selected;
}
function streamPosition(rows: StoredEvent[], subject: string) {
  let position = 0;
  for (const row of rows) {
    if (row.event.subject === subject) position = row.sequence;
  }
  return position;
}
async function refreshHistory(options: ChatOptions, rows: StoredEvent[], subject: string,
  deadline: number) {
  const position = streamPosition(rows, subject);
  const laterRows = options.store.readStream(subject, position + 1, deadline);
  for await (const row of laterRows) {
    if (row.event.silo !== options.silo) throw new Error('Conversation silo mismatch');
    rows.push(row);
  }
}
async function publish(options: ChatOptions, memberId: string, loaded: Loaded,
  value: unknown, secret: string) {
  const input = publishInput.parse(value);
  const binding = verify(secret, input.review);
  if (binding.silo !== options.silo || binding.publishedBy !== memberId ||
      binding.childConversationId !== loaded.child ||
      binding.parentConversationId !== loaded.origin.parentConversationId) throw new ChatRefused();
  await check(options, memberId, loaded, undefined, true);
  const previous = find(loaded.parentRows, input.id);
  if (previous) {
    return verifySaved(previous, options, binding, input);
  }
  const deadline = performance.now() + 10_000;
  while (performance.now() < deadline) {
    // Bind the following reads to the NATS append, including changes after the last read.
    const expectedGlobalSequence = await options.store.head(undefined, deadline);
    await refreshHistory(options, loaded.childRows, `conversation-${loaded.child}`, deadline);
    await refreshHistory(options, loaded.parentRows,
      `conversation-${binding.parentConversationId}`, deadline);
    const saved = find(loaded.parentRows, input.id);
    if (saved) return verifySaved(saved, options, binding, input);
    const response = await appendPublication(options, memberId, loaded, binding, input,
      expectedGlobalSequence, deadline);
    if (response) return response;
    // Retry only a definite conflict. Read new rows and check access again on the next attempt.
  }
  throw new Error('Publication unavailable');
}
async function appendPublication(options: ChatOptions, memberId: string, loaded: Loaded,
  binding: Binding, input: z.infer<typeof publishInput>, expectedGlobalSequence: number,
  deadline: number) {
  const selected = currentResult(loaded, binding, input.text);
  const subjects = [`member-${memberId}`, `participation-${loaded.child}`,
    ...inheritedChildSubjects(loaded.access), `participation-${binding.parentConversationId}`];
  const fresh = await authorityFence(options.store, performance.now(), subjects);
  const parent = await check(options, memberId, loaded, fresh.deadline);
  if (parent.accessPosition !== binding.accessPosition) throw new PublicationConflict('review_stale');
  const encrypted = options.keys.encrypt(options.silo, binding.parentConversationId, input.text);
  const data = childResultPublishedDataSchema.parse({
    conversationId: binding.parentConversationId, publishedBy: memberId,
    childConversationId: loaded.child, publicationKind: binding.publicationKind,
    resultEventId: binding.resultEventId, ...selected, reviewDigest: digest(input.review),
    ...encrypted, contentType: 'text' });
  const subject = `conversation-${binding.parentConversationId}`;
  const expectedSequence = streamPosition(loaded.parentRows, subject);
  const event = { id: input.id, commandId: input.id, type: 'conversation.child_result_published',
    subject, silo: options.silo, source: 'opencrane-server', time: new Date().toISOString(),
    principal: { kind: 'human' as const, id: memberId }, data };
  await fresh();
  if (binding.expiresAt <= Date.now()) throw new PublicationConflict('review_stale');
  const command = { event, expectedSequence, expectedGlobalSequence,
    historyChecked: true as const, deadline: Math.min(fresh.deadline, deadline) };
  const saved = await options.store.append(command);
  if (saved.status === 'conflict') return undefined;
  if (saved.status === 'rejected') throw new PublicationConflict('review_stale');
  if (saved.status !== 'appended') throw new Error('Publication unavailable');
  const row = await readEventAt(options.store, subject, saved.sequence, performance.now() + 10_000);
  if (!row) throw new Error('Publication unavailable');
  return verifySaved(row, options, binding, input);
}
export function registerPublicationRoutes(app: FastifyInstance, config: AuthConfig,
  options?: ChatOptions) {
  const base = '/api/conversations/:conversationId';
  function requestLog() {
    return { operation: 'child-publication' };
  }
  const logSerializers = { req: requestLog };
  function invalidBody(_error: unknown, _request: FastifyRequest, reply: FastifyReply) {
    reply.header('cache-control', 'no-store');
    return reply.code(400).send({ status: 'refused' });
  }
  const routeOptions = { bodyLimit: 160_000, logSerializers, errorHandler: invalidBody };
  app.post(`${base}/publication-review`, routeOptions, handler);
  app.post(`${base}/publications`, routeOptions, handler);
  async function handler(request: FastifyRequest, reply: FastifyReply) {
    reply.header('cache-control', 'no-store');
    try {
      const { conversationId } = z.object({ conversationId: chatIdSchema }).parse(request.params);
      const context = await requireMember(request, reply, config, options, { write: true });
      const loaded = await load(context.options, context.memberId, conversationId);
      const operation = request.routeOptions.url?.endsWith('/publication-review') ? review : publish;
      const response = await operation(context.options, context.memberId, loaded,
        request.body, config.cookieSecret);
      return reply.send(response);
    } catch (error) {
      if (error instanceof MemberRefusal) {
        return reply.code(error.statusCode).send({ status: error.status });
      }
      if (isChatRefused(error)) return reply.code(403).send({ status: 'refused' });
      if (error instanceof PublicationConflict) {
        return reply.code(409).send({ status: error.message });
      }
      if (isAuthorityChanged(error)) return reply.code(409).send({ status: 'review_stale' });
      if (error instanceof z.ZodError) return reply.code(400).send({ status: 'refused' });
      request.log.warn({ operation: 'child-publication' }, 'Publication unavailable');
      return reply.code(503).send({ status: 'unavailable' });
    }
  }
}
