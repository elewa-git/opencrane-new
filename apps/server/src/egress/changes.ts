import { egressGrantStream } from '@opencrane/projections';
import type { FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { Binding } from '@opencrane/authz';
import { readEventAt, type EventStore, type StoredEvent } from '@opencrane/event-store';
import { egressCommandSchema, egressDestinationDataSchema, egressRuleSchema,
  type EgressRule }
  from '@opencrane/events';
import { activeMember, currentMembership, history, ownershipWriteAccess, readActiveMember,
  ProviderConflict } from '@opencrane/models';
import { ChangeUnknown } from '../models/access-changes.ts';

export interface EgressOptions { silo: string; store: EventStore; binding: Binding }
function checkSilo(options: EgressOptions) {
  if (options.silo !== options.binding.silo) throw new Error('Wrong silo');
}
function checkedRule(options: EgressOptions, value: unknown) {
  checkSilo(options);
  const rule = egressRuleSchema.parse(value);
  if (rule.scope === 'silo' && rule.subjectId !== options.silo) throw new Error('Wrong silo');
  return rule;
}
async function ruleHistory(options: EgressOptions, rule: EgressRule, deadline: number) {
  const subject = egressGrantStream(options.silo, rule);
  const rows = await history(options.store, subject, options.silo, deadline);
  for (const row of rows) {
    const data = egressDestinationDataSchema.parse(row.event.data);
    if (egressGrantStream(options.silo, data) !== subject) throw new Error('Wrong rule');
  }
  return rows;
}
async function destinationHistory(options: EgressOptions, deadline: number) {
  const rows = await history(options.store, 'egress-*', options.silo, deadline);
  const rules: StoredEvent[] = [];
  for (const row of rows) {
    if (!['egress.destination_allowed', 'egress.destination_revoked'].includes(row.event.type)) {
      continue;
    }
    const data = egressDestinationDataSchema.parse(row.event.data);
    if (egressGrantStream(options.silo, data) !== row.event.subject) {
      throw new Error('Wrong rule');
    }
    rules.push(row);
  }
  return { rules, sequence: rows.at(-1)?.sequence ?? 0 };
}
function receipt(row: StoredEvent) {
  return { status: 'appended' as const, commandId: row.event.commandId,
    changeId: row.event.id, sequence: row.sequence, operation: row.event.type, time: row.event.time };
}
function checkOriginal(row: StoredEvent, type: string, memberId: string, data: unknown) {
  if (row.event.type !== type || row.event.principal?.kind !== 'human' ||
      row.event.principal.id !== memberId || JSON.stringify(row.event.data) !== JSON.stringify(data)) {
    throw new ProviderConflict('Conflict');
  }
}
export async function egressCommand(options: EgressOptions, memberId: string, value: unknown) {
  checkSilo(options);
  const input = egressCommandSchema.parse(value);
  const { scope, subjectId, host, port } = input;
  const rule = { scope, subjectId, host, port };
  checkedRule(options, rule);
  await readActiveMember(options.store, options.binding, memberId, 'admin');
  const subject = egressGrantStream(options.silo, rule);
  // Finish long reads before starting the two-second write check.
  const deadline = performance.now() + 10_000;
  const changes = await destinationHistory(options, deadline);
  function matchesRule(row: StoredEvent) {
    return row.event.subject === subject;
  }
  const rows = changes.rules.filter(matchesRule);
  const membership = await currentMembership(options.store, options.silo, memberId,
    undefined, deadline);
  const type = input.action === 'allow' ? 'egress.destination_allowed' : 'egress.destination_revoked';
  const data = egressDestinationDataSchema.parse({ ...rule,
    expectedSequence: input.expectedSequence, changedBy: memberId });
  function matchesCommand(row: StoredEvent) {
    return row.event.commandId === input.commandId;
  }
  const original = changes.rules.find(matchesCommand);
  if (original) {
    checkOriginal(original, type, memberId, data);
    return receipt(original);
  }
  if ((rows.at(-1)?.sequence ?? 0) !== input.expectedSequence) {
    throw new ProviderConflict('Conflict');
  }
  const fresh = await ownershipWriteAccess(options.store, membership.positions);
  await activeMember(options.store, options.binding, memberId,
    { requiredRole: 'admin', fresh, membership });
  const event = { id: randomUUID(), commandId: input.commandId, subject, silo: options.silo,
    type, data, time: new Date().toISOString(), source: 'opencrane-server', correlation: {},
    principal: { kind: 'human' as const, id: memberId } };
  await fresh();
  let result;
  try {
    // Check all destination changes so racing requests cannot reuse an id on another rule.
    // Refuse an unrelated policy save too; the caller must reload before trying again.
    const command = { event, expectedSequence: changes.sequence,
      expectedSubject: 'egress-*', historyChecked: true as const, deadline: fresh.deadline };
    result = await options.store.append(command);
  } catch {
    throw new ChangeUnknown('Unknown');
  }
  if (result.status === 'conflict') throw new ProviderConflict('Conflict');
  if (result.status !== 'appended') throw new ChangeUnknown('Unknown');
  let saved: StoredEvent | undefined;
  try {
    saved = await readEventAt(options.store, subject, result.sequence, fresh.deadline);
  } catch {
    throw new ChangeUnknown('Unknown');
  }
  if (!saved || saved.event.commandId !== input.commandId) throw new ChangeUnknown('Unknown');
  checkOriginal(saved, type, memberId, data);
  return receipt(saved);
}
export async function egressChange(options: EgressOptions, memberId: string,
  value: EgressRule, commandId: string) {
  const rule = checkedRule(options, value);
  await readActiveMember(options.store, options.binding, memberId, 'admin');
  const rows = await ruleHistory(options, rule, performance.now() + 10_000);
  function matchesCommand(row: StoredEvent) {
    return row.event.commandId === commandId && row.event.principal?.kind === 'human' &&
      row.event.principal.id === memberId;
  }
  const original = rows.find(matchesCommand);
  if (!original) return { status: 'unknown' as const };
  return receipt(original);
}

const changeParameters = z.object({ commandId: z.string().regex(/^[\w-]{1,200}$/u) }).strict();
const ruleQuery = egressRuleSchema.extend({ port: z.coerce.number().int().min(1).max(65535)
  .default(443) });
export async function writeEgress(request: FastifyRequest, reply: FastifyReply,
  options: EgressOptions, memberId: string) {
  return reply.send(await egressCommand(options, memberId, request.body));
}
export async function readEgressChange(request: FastifyRequest, reply: FastifyReply,
  options: EgressOptions, memberId: string) {
  const { commandId } = changeParameters.parse(request.params);
  const rule = ruleQuery.parse(request.query);
  return reply.send(await egressChange(options, memberId, rule, commandId));
}
