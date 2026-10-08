import { randomUUID } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { grantStream, memberAuthorisation } from '@opencrane/authz';
import { assistantCreatedDataSchema, legacyMemberRole, providerModelIdSchema,
  type EventEnvelope } from '@opencrane/events';
import { history, models, providerAuthority, readActiveMember, ProviderConflict, ProviderRefused }
  from '@opencrane/models';
import { modelAccessCommandSchema, modelAccessReceiptSchema,
  modelAccessChangeSchema } from '@opencrane/protocol';
import { readEventAt, type StoredEvent } from '@opencrane/event-store';
import type { GroupOptions as ModelAccessOptions } from '../members/group-routes.ts';

const parameters = z.object({ modelId: providerModelIdSchema }).strict();
const changeParameters = parameters.extend({ commandId: z.string().regex(/^[\w-]{1,200}$/u) });
export class ChangeUnknown extends Error {}
type TargetReason = 'model_unavailable' | 'target_unavailable' | 'target_changed';
export class TargetConflict extends Error {
  readonly reason: TargetReason;

  constructor(reason: TargetReason) {
    super(reason);
    this.reason = reason;
  }
}
type AccessCommand = z.infer<typeof modelAccessCommandSchema>;
type AccessCheck = Awaited<ReturnType<typeof providerAuthority>>;

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
  await readActiveMember(options.store, options.binding, memberId, 'admin');
  function matchesModel(model: (typeof models)[number]) {
    return model.id === modelId;
  }
  const model = models.find(matchesModel);
  if (!model || (input.action === 'grant' && model.retired)) {
    throw new TargetConflict('model_unavailable');
  }
  const subject = grantStream('model', modelId);
  // Read repeats before starting the short access check. Append reuses this checked history.
  const rows = await history(options.store, subject, options.silo, performance.now() + 10_000);
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
    await providerAuthority(options.store, options.binding, memberId);
    return reply.send(receipt(previous, modelId));
  }
  if ((rows.at(-1)?.sequence ?? 0) !== input.expectedSequence) throw new ProviderConflict();
  const checked = await checkAccessChange(options, memberId, input, modelId, model.retired, rows);
  if (checked.noEffect) return reply.send({ status: 'no_effect' });
  const event = { id: randomUUID(), commandId: input.commandId, subject, silo: options.silo,
    type, data, time: new Date().toISOString(), source: 'opencrane-server', correlation: {},
    principal: { kind: 'human' as const, id: memberId } };
  const saved = await appendGrant(options, event, input.expectedSequence,
    checked.fresh, checked.confirm);
  return reply.send(receipt(saved, modelId));
}

async function checkAccessChange(options: ModelAccessOptions, memberId: string,
  input: AccessCommand, modelId: string, retired: boolean, rows: StoredEvent[]) {
  const targetSubject = `${input.granteeKind}-${input.granteeId}`;
  const firstTarget = await prepareTarget(options, input, modelId, targetSubject, retired, rows);
  const fresh = await providerAuthority(options.store, options.binding, memberId);
  let checkedTarget: string | undefined;
  if (input.action === 'grant') {
    let target = firstTarget ? [firstTarget] : [];
    if (input.granteeKind !== 'team') {
      target = await readTargetHistory(options, targetSubject, fresh.deadline);
      checkedTarget = targetSubject;
    }
    if (!targetExists(target, input.granteeKind, input.granteeId)) {
      throw new TargetConflict('target_unavailable');
    }
  } else if (!revokeChangesAccess(rows, input, modelId, retired, firstTarget)) {
    await fresh();
    const position = await options.store.head(grantStream('model', modelId), fresh.deadline);
    if (position !== input.expectedSequence) {
      throw new ProviderConflict();
    }
    return { fresh, confirm: fresh, noEffect: true };
  }
  async function confirm() {
    await fresh();
    if (checkedTarget) {
      const targetPosition = await options.store.head(checkedTarget, fresh.deadline);
      await fresh();
      if (targetPosition > fresh.head) throw new TargetConflict('target_changed');
    }
  }
  return { fresh, confirm, noEffect: false };
}

async function prepareTarget(options: ModelAccessOptions, input: AccessCommand,
  modelId: string, targetSubject: string, retired: boolean, rows: StoredEvent[]) {
  const deadline = performance.now() + 10_000;
  let firstTarget: StoredEvent | undefined;
  if (input.action === 'grant' && input.granteeKind === 'team') {
    firstTarget = await readFirstTarget(options, targetSubject, deadline);
  } else if (input.action === 'revoke' && !retired && !latestGrant(rows, input)) {
    firstTarget = await startingGrantTarget(options, input, modelId, targetSubject, deadline);
  }
  return firstTarget;
}

function checkOriginal(event: EventEnvelope, type: string, memberId: string, data: unknown) {
  if (event.type !== type || event.principal?.id !== memberId ||
      event.principal?.kind !== 'human' ||
      JSON.stringify(event.data) !== JSON.stringify(data)) {
    throw new ProviderConflict();
  }
}

async function appendGrant(options: ModelAccessOptions, event: EventEnvelope,
  expectedSequence: number, fresh: AccessCheck, confirm: () => Promise<void>) {
  await confirm();
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
    await confirm();
  } catch {
    throw new ChangeUnknown();
  }
  if (!saved) throw new ChangeUnknown();
  if (saved.event.commandId !== event.commandId) throw new ProviderConflict();
  checkOriginal(saved.event, event.type, event.principal!.id, event.data);
  return saved;
}

async function readFirstTarget(options: ModelAccessOptions, subject: string, deadline: number) {
  for await (const row of options.store.readStream(subject, 1, deadline)) {
    if (row.event.silo !== options.silo) return undefined;
    return row;
  }
  return undefined;
}

async function readTargetHistory(options: ModelAccessOptions, subject: string, deadline: number) {
  try {
    return await history(options.store, subject, options.silo, deadline);
  } catch (error) {
    if (error instanceof Error && error.message === 'Wrong silo') {
      throw new TargetConflict('target_unavailable');
    }
    throw error;
  }
}

function latestGrant(rows: StoredEvent[], input: AccessCommand) {
  function matchesGrantee(row: StoredEvent) {
    const fields = z.record(z.string(), z.unknown()).parse(row.event.data);
    return fields['granteeId'] === input.granteeId &&
      (fields['granteeKind'] === input.granteeKind ||
        (row.event.type === 'grant.revoked' && fields['granteeKind'] === undefined));
  }
  return rows.findLast(matchesGrantee);
}

async function startingGrantTarget(options: ModelAccessOptions, input: AccessCommand,
  modelId: string, subject: string, deadline: number) {
  if (input.granteeKind === 'team') {
    // Read assistant selections before the short check. Their worker also grants the owning team.
    for await (const row of options.store.readStream('assistant-*', 1, deadline)) {
      if (row.event.silo !== options.silo || row.event.type !== 'assistant.created') continue;
      const assistant = assistantCreatedDataSchema.parse(row.event.data);
      if (assistant.kind === 'team' && assistant.ownerId === input.granteeId &&
          selectedModel(assistant, modelId)) return row;
    }
    return undefined;
  }
  if (input.granteeKind === 'assistant') {
    return readFirstTarget(options, subject, deadline);
  }
  for await (const row of options.store.readStream(subject, 1, deadline)) {
    if (row.event.silo !== options.silo) continue;
    if (!['member.joined', 'silo.owner_bootstrapped'].includes(row.event.type)) continue;
    const fields = z.record(z.string(), z.unknown()).parse(row.event.data);
    if (fields['memberId'] === input.granteeId) return row;
  }
  return undefined;
}

function revokeChangesAccess(rows: StoredEvent[], input: AccessCommand, modelId: string,
  retired: boolean, firstTarget: StoredEvent | undefined) {
  const previous = latestGrant(rows, input);
  if (previous) return previous.event.type === 'grant.given';
  // Save a revoke before the starting-grant reaction runs, so it cannot restore access later.
  if (retired || !firstTarget) return false;
  if (input.granteeKind === 'member') {
    return ['member.joined', 'silo.owner_bootstrapped'].includes(firstTarget.event.type);
  }
  if (firstTarget.event.type !== 'assistant.created') return false;
  const assistant = assistantCreatedDataSchema.parse(firstTarget.event.data);
  if (input.granteeKind === 'assistant' && assistant.kind === 'personal') return true;
  return selectedModel(assistant, modelId);
}

function selectedModel(assistant: z.infer<typeof assistantCreatedDataSchema>, modelId: string) {
  function selectsModel(grant: NonNullable<typeof assistant.grants>[number]) {
    return grant.resourceType === 'model' && grant.resourceId === modelId;
  }
  return assistant.grants?.some(selectsModel) ?? false;
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
  await readActiveMember(options.store, options.binding, memberId, 'admin');
  const subject = grantStream('model', modelId);
  const rows = await history(options.store, subject, options.silo, performance.now() + 10_000);
  function matchesCommand(row: StoredEvent) {
    return row.event.commandId === commandId;
  }
  const original = rows.find(matchesCommand);
  if (!original) {
    return reply.code(404).send({ status: 'unknown' });
  }
  const checkpoint = await options.db.query<{ sequence: string }>(
    'SELECT sequence FROM projection_checkpoints WHERE name = $1', ['model-access']);
  const applied = await memberAuthorisation(options.binding).applied(original.event.id);
  const contentCurrent = Number(checkpoint.rows[0]?.sequence ?? 0) >= original.sequence;
  const projection = { content: contentCurrent ? 'current' : 'applying',
    iam: applied ? 'current' : 'applying' };
  const response = { ...receipt(original, modelId), projection,
    currentSequence: rows.at(-1)?.sequence ?? 0 };
  return reply.send(modelAccessChangeSchema.parse(response));
}
