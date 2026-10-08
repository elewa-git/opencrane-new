import { randomUUID } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { grantStream, memberAuthorisation } from '@opencrane/authz';
import { legacyMemberRole, providerModelIdSchema, type EventEnvelope } from '@opencrane/events';
import { history, models, providerAuthority, readActiveMember, ProviderConflict, ProviderRefused }
  from '@opencrane/models';
import { modelAccessCommandSchema, modelAccessReceiptSchema, modelAccessChangeSchema } from '@opencrane/protocol';
import { readEventAt, type StoredEvent } from '@opencrane/event-store';
import type { GroupOptions as ModelAccessOptions } from '../members/group-routes.ts';

const parameters = z.object({ modelId: providerModelIdSchema }).strict();
const changeParameters = parameters.extend({ commandId: z.string().regex(/^[\w-]{1,200}$/u) });
export class ChangeUnknown extends Error {}

function receipt(row: StoredEvent, modelId: string) {
  const result = { status: 'appended', modelId,
    commandId: row.event.commandId, operation: row.event.type,
    sequence: row.sequence, changeId: row.event.id };
  return modelAccessReceiptSchema.parse(result);
}

export async function writeAccess(request: FastifyRequest, reply: FastifyReply,
  options: ModelAccessOptions, memberId: string) {
  const { modelId } = parameters.parse(request.params);
  const input = modelAccessCommandSchema.parse(request.body);
  const subject = grantStream('model', modelId);
  // Read repeats before starting the short access check. Append reuses this checked history.
  const rows = await history(options.store, subject, options.silo, performance.now() + 10_000);
  const fresh = await providerAuthority(options.store, options.binding, memberId);
  function matchesCommand(row: StoredEvent) {
    return row.event.commandId === input.commandId;
  }
  const previous = rows.find(matchesCommand);
  const type = input.action === 'grant' ? 'grant.given' : 'grant.revoked';
  const data = { resourceType: 'model', resourceId: modelId,
    granteeId: input.granteeId, granteeKind: input.granteeKind,
    ...(input.action === 'grant' ? { grantedBy: memberId } : { revokedBy: memberId }) };
  if (previous) {
    const previousIndex = rows.indexOf(previous);
    const originalExpected = rows[previousIndex - 1]?.sequence ?? 0;
    if (originalExpected !== input.expectedSequence) throw new ProviderConflict();
    checkOriginal(previous.event, type, memberId, data);
    await fresh();
    return reply.send(receipt(previous, modelId));
  }
  if ((rows.at(-1)?.sequence ?? 0) !== input.expectedSequence) throw new ProviderConflict();
  function supported(model: (typeof models)[number]) {
    return model.id === modelId && !model.retired;
  }
  if (input.action === 'grant' && !models.some(supported)) throw new ProviderRefused();
  const targetSubject = `${input.granteeKind}-${input.granteeId}`;
  fresh.include(targetSubject);
  const target = await history(options.store, targetSubject, options.silo, fresh.deadline);
  if (!targetExists(target, input.granteeKind, input.granteeId)) throw new ProviderRefused();
  const event = { id: randomUUID(), commandId: input.commandId, subject, silo: options.silo,
    type, data, time: new Date().toISOString(), source: 'opencrane-server', correlation: {},
    principal: { kind: 'human' as const, id: memberId } };
  const saved = await appendGrant(options, event, input.expectedSequence, fresh);
  return reply.send(receipt(saved, modelId));
}

function checkOriginal(event: EventEnvelope, type: string, memberId: string, data: unknown) {
  if (event.type !== type || event.principal?.id !== memberId ||
      event.principal?.kind !== 'human' ||
      JSON.stringify(event.data) !== JSON.stringify(data)) {
    throw new ProviderConflict();
  }
}

async function appendGrant(options: ModelAccessOptions, event: EventEnvelope,
  expectedSequence: number, fresh: Awaited<ReturnType<typeof providerAuthority>>) {
  await fresh();
  let result;
  try {
    const command = { event, expectedSequence,
      historyChecked: true as const, deadline: fresh.deadline };
    result = await options.store.append(command);
  } catch {
    throw new ChangeUnknown();
  }
  if (result.status === 'conflict') throw new ProviderConflict();
  if (result.status === 'rejected') throw new ProviderRefused();
  if (result.status !== 'appended') throw new ChangeUnknown();
  let saved;
  try {
    saved = await readEventAt(options.store, event.subject, result.sequence, fresh.deadline);
    await fresh();
  } catch {
    throw new ChangeUnknown();
  }
  if (!saved) throw new ChangeUnknown();
  if (saved.event.type !== event.type || saved.event.principal?.id !== event.principal?.id ||
      saved.event.principal?.kind !== 'human' ||
      saved.event.commandId !== event.commandId ||
      JSON.stringify(saved.event.data) !== JSON.stringify(event.data)) throw new ProviderConflict();
  return saved;
}

function targetExists(rows: StoredEvent[], kind: string, id: string) {
  if (kind === 'member') {
    function hasRole(row: StoredEvent) {
      return legacyMemberRole(row.event) !== undefined;
    }
    const current = rows.findLast(hasRole);
    if (!current || !legacyMemberRole(current.event)) return false;
    const data = z.record(z.string(), z.unknown()).parse(current.event.data);
    return data['memberId'] === id;
  }
  const created = rows[0]?.event;
  const field = kind === 'team' ? 'teamId' : 'assistantId';
  const data = z.record(z.string(), z.unknown()).parse(created?.data ?? {});
  return created?.type === `${kind}.created` && data[field] === id;
}

export async function readChange(request: FastifyRequest, reply: FastifyReply,
  options: ModelAccessOptions, memberId: string) {
  const { modelId, commandId } = changeParameters.parse(request.params);
  const subject = grantStream('model', modelId);
  const rows = await history(options.store, subject, options.silo, performance.now() + 10_000);
  function matchesCommand(row: StoredEvent) {
    return row.event.commandId === commandId;
  }
  const original = rows.find(matchesCommand);
  if (!original) {
    await readActiveMember(options.store, options.binding, memberId, 'admin');
    return reply.code(404).send({ status: 'unknown' });
  }
  const checkpoint = await options.db.query<{ sequence: string }>(
    'SELECT sequence FROM projection_checkpoints WHERE name = $1', ['model-access']);
  const applied = await memberAuthorisation(options.binding).applied(original.event.id);
  const contentCurrent = Number(checkpoint.rows[0]?.sequence ?? 0) >= original.sequence;
  const projection = { content: contentCurrent ? 'current' : 'applying',
    iam: applied ? 'current' : 'applying' };
  await readActiveMember(options.store, options.binding, memberId, 'admin');
  const response = { ...receipt(original, modelId), projection,
    currentSequence: rows.at(-1)?.sequence ?? 0 };
  return reply.send(modelAccessChangeSchema.parse(response));
}
