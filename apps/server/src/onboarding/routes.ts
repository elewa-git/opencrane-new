import { z } from 'zod';
import type { FastifyInstance, FastifyReply, FastifyRequest, FastifyError } from 'fastify';
import type { AuthConfig } from '@opencrane/auth';
import { surveyAnswersSchema } from '@opencrane/events';
import { isAuthorityChanged, AuthorityApplying } from '@opencrane/models';
import { chatAccess, isChatRefused, ChatAccessApplying, type ChatOptions } from '../chat/access.ts';
import { requireMember, MemberRefusal, idSchema } from '../members/guard.ts';
import { surveyCommand, SurveyConflict, SurveyUnknown } from './commands.ts';
import { surveyHistory, savedCommand, decryptAnswers, surveyReceipt } from './history.ts';

const parameters = z.strictObject({ commandId: idSchema });
export function registerSurveyRoutes(app: FastifyInstance, config: AuthConfig, options?: ChatOptions) {
  app.get('/api/onboarding', handler);
  app.get('/api/personal/changes/:commandId', handler);
  const writeRoute = { method: 'POST' as const, url: '/api/onboarding/survey',
    bodyLimit: 16384, errorHandler: bodyRefusal, handler };
  app.route(writeRoute);
  async function handler(request: FastifyRequest, reply: FastifyReply) {
    try {
      const checks = { write: request.method === 'POST' };
      const context = await requireMember(request, reply, config, options, checks);
      const configured = context.options;
      const memberId = context.memberId;
      if (checks.write) return await surveyCommand(configured, memberId, request.body);
      const history = await surveyHistory(configured, memberId);
      // Check membership again after slow content reads, before returning private text.
      const accessRequest = { memberId };
      await chatAccess(configured, accessRequest);
      if (request.routeOptions.url === '/api/personal/changes/:commandId') {
        const { commandId } = parameters.parse(request.params);
        const saved = await savedCommand(configured, memberId, commandId, history);
        if (!saved) return { status: 'unknown' };
        return surveyReceipt(saved.row);
      }
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
