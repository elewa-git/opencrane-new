import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AuthConfig } from '@opencrane/auth';
import type { Binding } from '@opencrane/authz';
import type { EventStore } from '@opencrane/event-store';
import { companyOptInSetDataSchema } from '@opencrane/events';
import { changeCompanyOptIn, CompanyOptInConflict, CompanyOptInInputInvalid }
  from '@opencrane/models';
import { z } from 'zod';
import { sameOrigin } from '../members/guard.ts';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/u);
const parameters = z.strictObject({ serverId: id });
const emptyQuery = z.strictObject({});
const fields = companyOptInSetDataSchema.omit({ serverId: true, changedBy: true });
const bodySchema = fields.extend({ changeRef: id });

export async function writeCompanyOptIn(request: FastifyRequest, reply: FastifyReply,
  config: AuthConfig, options: { store?: EventStore; binding: Binding }, memberId: string) {
  if (!sameOrigin(request, config)) {
    return reply.code(403).send({ status: 'refused' });
  }
  const reference = parameters.parse(request.params);
  emptyQuery.parse(request.query);
  const body = bodySchema.parse(request.body);
  if (!options.store) {
    return reply.code(503).send({ status: 'unavailable' });
  }
  try {
    const input = { ...body, ...reference };
    // Let the command load history before starting its short write access check.
    const receipt = await changeCompanyOptIn(options.store, options.binding, memberId, input);
    return reply.send(receipt);
  } catch (error) {
    if (error instanceof CompanyOptInInputInvalid) {
      return reply.code(400).send({ status: 'invalid_request' });
    }
    if (error instanceof CompanyOptInConflict) {
      return reply.code(409).send({ status: 'conflict' });
    }
    throw error;
  }
}
