import { randomUUID } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { grantStream, memberAuthorisation } from '@opencrane/authz';
import { legacyMemberRole, type EventEnvelope } from '@opencrane/events';
import { readEventAt, type StoredEvent } from '@opencrane/event-store';
import { history, providerAuthority, readActiveMember, ProviderConflict, ProviderRefused }
  from '@opencrane/models';
import { modelAccessCommandSchema, modelAccessReceiptSchema, modelAccessChangeSchema }
  from '@opencrane/protocol';
import type { GroupOptions as ModelAccessOptions } from '../members/group-routes.ts';
import { ChangeUnknown, TargetConflict } from '../models/access-changes.ts';

const identifierSchema = z.string();
const id = identifierSchema.regex(/^[\w-]{1,200}$/u);
const parameters = z.strictObject({ serverId: id });
const changeParameters = parameters.extend({ commandId: id });
const modelIdField = { modelId: true } as const;
const serverIdField = { serverId: id };
const receiptWithoutModel = modelAccessReceiptSchema.omit(modelIdField);
const receiptSchema = receiptWithoutModel.extend(serverIdField);
const changeWithoutModel = modelAccessChangeSchema.omit(modelIdField);
const changeSchema = changeWithoutModel.extend(serverIdField);
type AccessCommand = z.infer<typeof modelAccessCommandSchema>;

function receipt(row: StoredEvent, serverId: string) {
  const result = { status: 'appended', serverId,
    commandId: row.event.commandId, operation: row.event.type,
    sequence: row.sequence, changeId: row.event.id };
  return receiptSchema.parse(result);
}

function checkOriginal(saved: StoredEvent, event: EventEnvelope) {
  if (saved.event.silo !== event.silo || saved.event.subject !== event.subject ||
      saved.event.commandId !== event.commandId || saved.event.type !== event.type ||
      saved.event.principal?.kind !== 'human' || saved.event.principal.id !== event.principal?.id ||
      JSON.stringify(saved.event.data) !== JSON.stringify(event.data)) {
    throw new ProviderConflict();
  }
}

export async function writeToolAccess(request: FastifyRequest, reply: FastifyReply,
  options: ModelAccessOptions, memberId: string) {
  const { serverId } = parameters.parse(request.params);
  const input = modelAccessCommandSchema.parse(request.body);
  await readActiveMember(options.store, options.binding, memberId, 'admin');
  const subject = grantStream('mcp_server', serverId);
  const deadline = performance.now() + 10_000;
  const rows = await history(options.store, subject, options.silo, deadline);
  const type = input.action === 'grant' ? 'grant.given' : 'grant.revoked';
  const data = { resourceType: 'mcp_server', resourceId: serverId,
    granteeId: input.granteeId, granteeKind: input.granteeKind,
    ...(input.action === 'grant' ? { grantedBy: memberId } : { revokedBy: memberId }) };
  const event = { id: randomUUID(), commandId: input.commandId, subject, silo: options.silo,
    type, data, time: new Date().toISOString(), source: 'opencrane-server', correlation: {},
    principal: { kind: 'human' as const, id: memberId } };
  function matchesCommand(row: StoredEvent) {
    return row.event.commandId === input.commandId;
  }
  const previous = rows.find(matchesCommand);
  if (previous) {
    const index = rows.indexOf(previous);
    if ((rows[index - 1]?.sequence ?? 0) !== input.expectedSequence) throw new ProviderConflict();
    checkOriginal(previous, event);
    await providerAuthority(options.store, options.binding, memberId);
    return reply.send(receipt(previous, serverId));
  }
  if ((rows.at(-1)?.sequence ?? 0) !== input.expectedSequence) throw new ProviderConflict();
  const positions = await prepareTargets(options, input, serverId, deadline);
  const fresh = await providerAuthority(options.store, options.binding, memberId);
  async function confirm() {
    await fresh();
    for (const [stream, position] of positions) {
      if (await options.store.head(stream, fresh.deadline) !== position) {
        throw new TargetConflict('target_changed');
      }
    }
    await fresh();
  }
  await confirm();
  const saved = await appendGrant(options, event, input.expectedSequence, fresh.deadline, confirm);
  return reply.send(receipt(saved, serverId));
}

async function appendGrant(options: ModelAccessOptions, event: EventEnvelope,
  expectedSequence: number, deadline: number, confirm: () => Promise<void>) {
  let result;
  try {
    const command = { event, expectedSequence, historyChecked: true as const, deadline };
    result = await options.store.append(command);
  } catch {
    throw new ChangeUnknown();
  }
  if (result.status === 'rejected') throw new ProviderRefused();
  if (result.status !== 'appended' && result.status !== 'conflict') throw new ChangeUnknown();
  // A concurrent identical command may have saved the original. Never append a second time.
  let saved;
  try {
    if (result.status === 'appended') {
      saved = await readEventAt(options.store, event.subject, result.sequence, deadline);
    } else {
      // Stream positions use the global log. Unrelated events may occupy intervening positions.
      for await (const row of options.store.readStream(event.subject, expectedSequence + 1, deadline)) {
        saved = row;
        break;
      }
    }
    await confirm();
  } catch {
    throw new ChangeUnknown();
  }
  if (!saved) {
    if (result.status === 'conflict') throw new ProviderConflict();
    throw new ChangeUnknown();
  }
  checkOriginal(saved, event);
  return saved;
}

async function prepareTargets(options: ModelAccessOptions, input: AccessCommand,
  serverId: string, deadline: number) {
  const serverSubject = `mcp-${serverId}`;
  const server = await history(options.store, serverSubject, options.silo, deadline);
  const registered = server[0]?.event;
  const fields = z.record(z.string(), z.unknown()).parse(registered?.data ?? {});
  if (registered?.type !== 'mcp.server_registered' || fields['serverId'] !== serverId) {
    throw new ProviderConflict();
  }
  const positions = new Map([[serverSubject, server.at(-1)!.sequence]]);
  if (input.action === 'revoke') return positions;
  function changesAvailability(row: StoredEvent) {
    return ['mcp.server_registered', 'mcp.server_discovered', 'mcp.server_published',
      'mcp.server_rejected', 'mcp.server_unpublished'].includes(row.event.type);
  }
  const last = server.findLast(changesAvailability)!;
  if (['mcp.server_rejected', 'mcp.server_unpublished'].includes(last.event.type)) {
    throw new ProviderConflict();
  }
  const targetSubject = `${input.granteeKind}-${input.granteeId}`;
  const target: StoredEvent[] = [];
  for await (const row of options.store.readStream(targetSubject, 1, deadline)) {
    if (row.event.silo !== options.silo) throw new TargetConflict('target_unavailable');
    target.push(row);
    // Groups have no inactive state. Membership activity must not block their grants.
    if (input.granteeKind === 'team') break;
  }
  if (!activeTarget(target, input)) throw new TargetConflict('target_unavailable');
  if (input.granteeKind !== 'team') {
    positions.set(targetSubject, target.at(-1)!.sequence);
  }
  return positions;
}

function activeTarget(rows: StoredEvent[], input: AccessCommand) {
  if (input.granteeKind === 'member') {
    function changesMembership(row: StoredEvent) {
      return legacyMemberRole(row.event) !== undefined;
    }
    const current = rows.findLast(changesMembership);
    if (!current || !legacyMemberRole(current.event)) return false;
    const fields = z.record(z.string(), z.unknown()).parse(current.event.data);
    return fields['memberId'] === input.granteeId;
  }
  const created = rows[0]?.event;
  const fields = z.record(z.string(), z.unknown()).parse(created?.data ?? {});
  if (created?.type !== `${input.granteeKind}.created` ||
      fields[`${input.granteeKind}Id`] !== input.granteeId) return false;
  let active = true;
  for (const row of rows) {
    if (row.event.type !== 'assistant.settings_changed') continue;
    const data = z.record(z.string(), z.unknown()).parse(row.event.data);
    if (typeof data['active'] === 'boolean') active = data['active'];
  }
  return active;
}

export async function readToolAccessChange(request: FastifyRequest, reply: FastifyReply,
  options: ModelAccessOptions, memberId: string) {
  const { serverId, commandId } = changeParameters.parse(request.params);
  await readActiveMember(options.store, options.binding, memberId, 'admin');
  const rows = await history(options.store, grantStream('mcp_server', serverId),
    options.silo, performance.now() + 10_000);
  function matchesCommand(row: StoredEvent) {
    return row.event.commandId === commandId;
  }
  const original = rows.find(matchesCommand);
  if (!original) {
    const response = { status: 'unknown' };
    reply.code(404);
    return reply.send(response);
  }
  // Confirm this event in the generic inventory worker, never the model-only checkpoint.
  const content = await options.db.query(
    'SELECT event_id FROM projection_events WHERE projection = $1 AND event_id = $2',
    ['members', original.event.id]);
  const applied = await memberAuthorisation(options.binding).applied(original.event.id);
  const projection = { content: content.rows.length ? 'current' : 'applying',
    iam: applied ? 'current' : 'applying' };
  const response = { ...receipt(original, serverId), projection,
    currentSequence: rows.at(-1)?.sequence ?? 0 };
  const validatedResponse = changeSchema.parse(response);
  return reply.send(validatedResponse);
}
