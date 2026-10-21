import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { grantStream, memberAuthorisation } from '@opencrane/authz';
import { grantGivenDataSchema, grantRevokedDataSchema } from '@opencrane/events';
import { readEventAt } from '@opencrane/event-store';
import { readActiveMember } from '@opencrane/models';
import { inventoryIndexState, readModelAccessCandidates, readToolGrantReferences }
  from '@opencrane/projections';
import { modelAccessCandidatesQuerySchema, modelAccessCandidatesResponseSchema,
  modelAccessGrantSchema } from '@opencrane/protocol';
import type { GroupOptions } from '../members/group-routes.ts';

const id = z.string().regex(/^[\w-]{1,200}$/u);
const parameters = z.strictObject({ serverId: id });
const emptyQuery = z.strictObject({});
const registration = z.object({ serverId: id });
const sources = { member: 'direct', team: 'group', assistant: 'assistant' } as const;
const toolGrantSchema = modelAccessGrantSchema.extend({
  membershipStatus: z.enum(['joined', 'invited', 'departed', 'unknown']).nullable(),
});

function membershipStatus(reference: Awaited<ReturnType<typeof readToolGrantReferences>>[number]) {
  if (reference.granteeKind !== 'member') return null;
  if (reference.membershipStatus === 'removed') return 'departed';
  if (reference.membershipStatus === 'joined' || reference.membershipStatus === 'invited') {
    return reference.membershipStatus;
  }
  return 'unknown';
}

async function registered(options: GroupOptions, serverId: string, deadline: number) {
  // Read only the first server event. Registration does not grant tool use.
  for await (const row of options.store.readStream(`mcp-${serverId}`, 1, deadline)) {
    return row.event.silo === options.silo && row.event.type === 'mcp.server_registered' &&
      registration.parse(row.event.data).serverId === serverId;
  }
  return false;
}

async function progress(options: GroupOptions, deadline: number) {
  const position = await options.store.head(undefined, deadline);
  const result = await options.db.query<{ sequence: string; count: number }>(
    `SELECT MIN(sequence) AS sequence, COUNT(*)::int AS count FROM projection_checkpoints
      WHERE name = ANY($1::text[])`, [['members', 'groups', 'model-access']]);
  const index = await inventoryIndexState(options.db);
  const sequence = Number(result.rows[0]?.sequence ?? 0);
  const current = index.backfilled && result.rows[0]?.count === 3 && sequence >= position;
  const content = current ? 'current' as const : 'applying' as const;
  return { content, sequence };
}

export async function readToolCandidates(request: FastifyRequest, reply: FastifyReply,
  options: GroupOptions, memberId: string) {
  await readActiveMember(options.store, options.binding, memberId, 'admin');
  const { serverId } = parameters.parse(request.params);
  const query = modelAccessCandidatesQuerySchema.parse(request.query);
  const deadline = performance.now() + 10_000;
  if (!await registered(options, serverId, deadline)) {
    return reply.code(404).send({ status: 'not_found' });
  }
  const projection = await progress(options, deadline);
  const candidates = await readModelAccessCandidates(options.db, options.silo,
    query.kind, query.after, query.limit);
  const hasMore = candidates.length > query.limit;
  const rows = candidates.slice(0, query.limit);
  const next = hasMore ? rows.at(-1)!.id : null;
  const response = { rows, next, loadedAt: new Date().toISOString(), projection };
  return reply.send(modelAccessCandidatesResponseSchema.parse(response));
}

async function grantRow(options: GroupOptions, serverId: string,
  reference: Awaited<ReturnType<typeof readToolGrantReferences>>[number], deadline: number) {
  const sequence = Number(reference.position);
  const subject = grantStream('mcp_server', serverId);
  const saved = await readEventAt(options.store, subject, sequence, deadline);
  if (!saved || saved.event.silo !== options.silo || saved.event.id !== reference.eventId ||
      !['grant.given', 'grant.revoked'].includes(saved.event.type)) {
    throw new Error('Grant reference unavailable');
  }
  const given = saved.event.type === 'grant.given';
  const fields = given ? grantGivenDataSchema.parse(saved.event.data)
    : grantRevokedDataSchema.parse(saved.event.data);
  if (fields.resourceType !== 'mcp_server' || fields.resourceId !== serverId ||
      fields.granteeId !== reference.granteeId ||
      fields.granteeKind && fields.granteeKind !== reference.granteeKind) {
    throw new Error('Grant reference mismatch');
  }
  const applied = await memberAuthorisation(options.binding).applied(saved.event.id);
  const row = { granteeKind: reference.granteeKind, granteeId: reference.granteeId,
    displayName: reference.displayName, source: sources[reference.granteeKind],
    membershipStatus: membershipStatus(reference),
    state: given ? 'granted' : 'revoked', eventId: saved.event.id, eventTime: saved.event.time,
    sequence, projection: 'current' };
  return { ...toolGrantSchema.parse(row), iam: applied ? 'current' : 'applying' };
}

export async function readToolAccess(request: FastifyRequest, reply: FastifyReply,
  options: GroupOptions, memberId: string) {
  await readActiveMember(options.store, options.binding, memberId, 'admin');
  const { serverId } = parameters.parse(request.params);
  emptyQuery.parse(request.query);
  const deadline = performance.now() + 10_000;
  if (!await registered(options, serverId, deadline)) {
    return reply.code(404).send({ status: 'not_found' });
  }
  const subject = grantStream('mcp_server', serverId);
  const expectedSequence = await options.store.head(subject, deadline);
  const projection = await progress(options, deadline);
  const references = await readToolGrantReferences(options.db, options.silo, subject);
  let iam = 'current';
  const grants = [];
  for (const reference of references.slice(0, 100)) {
    const row = await grantRow(options, serverId, reference, deadline);
    if (row.sequence > expectedSequence) projection.content = 'applying';
    row.projection = projection.content;
    if (row.iam !== 'current') iam = 'applying';
    grants.push(row);
  }
  const complete = projection.content === 'current' && references.length <= 100;
  if (!complete) iam = 'applying';
  const response = { serverId, expectedSequence, loadedAt: new Date().toISOString(),
    canManage: true, grants, complete, grantTotal: complete ? grants.length : null,
    projection: { ...projection, iam } };
  return reply.send(response);
}
