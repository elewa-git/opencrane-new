import { z } from 'zod';
import type { FastifyInstance, FastifyReply, FastifyRequest, FastifyError } from 'fastify';
import type { AuthConfig } from '@opencrane/auth';
import { surveyAnswersSchema } from '@opencrane/events';
import { isAuthorityChanged, AuthorityApplying } from '@opencrane/models';
import { chatAccess, isChatRefused, ChatAccessApplying, type ChatOptions } from '../chat/access.ts';
import { requireMember, MemberRefusal, idSchema } from '../members/guard.ts';
import { surveyCommand, SurveyConflict, SurveyUnknown } from './commands.ts';
import { surveyHistory, savedCommand, decryptAnswers, decryptPersona,
  personaEvent, personaReceipt, surveyReceipt } from './history.ts';

const parameters = z.strictObject({ commandId: idSchema });
const revisionParameters = z.strictObject({ revisionId: idSchema });
const pageParameters = z.strictObject({ limit: z.coerce.number().int().min(1).max(50).optional(),
  before: z.coerce.number().int().positive().optional() });
export function registerSurveyRoutes(app: FastifyInstance, config: AuthConfig, options?: ChatOptions) {
  app.get('/api/onboarding', handler);
  app.get('/api/personal/changes/:commandId', handler);
  app.get('/api/onboarding/persona/revisions', handler);
  app.get('/api/onboarding/persona/revisions/:revisionId', handler);
  const writeRoute = { method: 'POST' as const, url: '/api/onboarding/survey',
    bodyLimit: 16384, errorHandler: bodyRefusal, handler };
  app.route(writeRoute);
  app.route({ ...writeRoute, url: '/api/onboarding/persona' });
  async function handler(request: FastifyRequest, reply: FastifyReply) {
    try {
      const checks = { write: request.method === 'POST' };
      const context = await requireMember(request, reply, config, options, checks);
      const configured = context.options;
      const memberId = context.memberId;
      if (checks.write) {
        let route: 'survey' | 'persona' = 'survey';
        if (request.routeOptions.url === '/api/onboarding/persona') route = 'persona';
        return await surveyCommand(configured, memberId, request.body, route);
      }
      const history = await surveyHistory(configured, memberId);
      // Check membership again after slow content reads, before returning private text.
      const accessRequest = { memberId };
      await chatAccess(configured, accessRequest);
      const special = await readSpecial(request, reply, configured, memberId, history);
      if (special !== undefined) return special;
      function readStep(row: typeof history.steps[number]) {
        const answers = surveyAnswersSchema.parse(decryptAnswers(configured, memberId, row.event));
        return { ...surveyReceipt(row), answers };
      }
      const steps = history.steps.map(readStep);
      let state = 'survey';
      if (history.position === 0) state = 'not_started';
      if (steps.length === 4) state = 'review';
      let nextStep: number | null = steps.length + 1;
      if (steps.length === 4) nextStep = null;
      const references = [...history.commands.values()];
      function receiptFor(reference: typeof references[number]) {
        const { sequence: _sequence, previousPosition: _previous, generation: _generation,
          ...receipt } = reference;
        return receipt;
      }
      const recentReferences = references.slice(-20);
      const recentReceipts = recentReferences.map(receiptFor);
      const survey = { generation: history.generation, position: history.position, nextStep, steps };
      return { state, allowedActions: ['save_step', 'restart'], recentReceipts, survey };
    } catch (error) {
      return surveyRefusal(reply, error);
    }
  }
}

type History = Awaited<ReturnType<typeof surveyHistory>>;
async function readSpecial(request: FastifyRequest, reply: FastifyReply,
  options: ChatOptions, memberId: string, history: History) {
  const path = request.routeOptions.url;
  if (path === '/api/personal/changes/:commandId') {
    const { commandId } = parameters.parse(request.params);
    const saved = await savedCommand(options, memberId, commandId, history);
    if (!saved) return { status: 'unknown' };
    if (saved.row.event.type === 'onboarding.persona_revised') {
      return personaReceipt(saved.row);
    }
    return surveyReceipt(saved.row);
  }
  if (path === '/api/onboarding/persona/revisions') {
    return listRevisions(request, history);
  }
  if (path === '/api/onboarding/persona/revisions/:revisionId') {
    return readRevision(request, reply, options, memberId, history);
  }
  return undefined;
}
function listRevisions(request: FastifyRequest, history: History) {
  const { limit = 20, before } = pageParameters.parse(request.query);
  function isBefore(reference: typeof history.revisions[number]) {
    return before === undefined || reference.revision < before;
  }
  const selected = history.revisions.filter(isBefore);
  const page = selected.slice(-limit).reverse();
  function metadata(reference: typeof page[number]) {
    return { revision: reference.revision, revisionId: reference.eventId,
      position: reference.sequence, generation: reference.generation,
      time: reference.time, current: reference.revision === history.currentRevision };
  }
  const revisions = page.map(metadata);
  const last = page.at(-1);
  let nextBefore: number | null = null;
  if (last && selected.length > page.length) nextBefore = last.revision;
  return { revisions, nextBefore, currentRevision: history.currentRevision };
}
async function readRevision(request: FastifyRequest, reply: FastifyReply,
  options: ChatOptions, memberId: string, history: History) {
  const { revisionId } = revisionParameters.parse(request.params);
  function matchesId(reference: typeof history.revisions[number]) {
    return reference.eventId === revisionId || String(reference.revision) === revisionId;
  }
  const reference = history.revisions.find(matchesId);
  if (!reference) return reply.code(404).send({ status: 'not_found' });
  const row = await personaEvent(options, memberId, reference);
  const replacement = decryptPersona(options, memberId, row.event);
  return { ...personaReceipt(row), generation: reference.generation,
    current: reference.revision === history.currentRevision, replacement };
}

function surveyRefusal(reply: FastifyReply, error: unknown) {
  if (error instanceof MemberRefusal) {
    return reply.code(error.statusCode).send({ status: error.status });
  }
  if (error instanceof z.ZodError) return reply.code(422).send({ status: 'invalid' });
  if (error instanceof SurveyConflict || isAuthorityChanged(error)) {
    return reply.code(409).send({ status: 'conflict' });
  }
  if (isChatRefused(error)) return reply.code(403).send({ status: 'refused' });
  if (error instanceof ChatAccessApplying || error instanceof AuthorityApplying) {
    return reply.code(425).send({ status: 'access_applying' });
  }
  if (error instanceof SurveyUnknown) return reply.code(503).send({ status: 'unknown' });
  return reply.code(503).send({ status: 'unavailable' });
}

function bodyRefusal(error: FastifyError, _request: FastifyRequest, reply: FastifyReply) {
  reply.header('cache-control', 'no-store');
  if (error.statusCode === 400 || error.statusCode === 413) {
    return reply.code(422).send({ status: 'invalid' });
  }
  return reply.code(503).send({ status: 'unavailable' });
}
