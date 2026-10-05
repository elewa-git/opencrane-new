import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { memberAuthorisation, type Binding } from '@opencrane/authz';
import type { EventStore, StoredEvent } from '@opencrane/event-store';
import { applyProvider, type ProviderState } from '@opencrane/projections';
import { authorityFence } from './authority.ts';
import { history } from './actor.ts';
import { models } from './state.ts';

const id = z.string().regex(/^[\w-]{1,200}$/u);
const modelId = z.string().regex(/^[\w.-]{1,200}$/u);
function noNul(value: string) {
  return !value.includes('\0');
}
const common = { commandId: id, providerId: id, expectedRevision: z.int().nonnegative() };
export const providerCommandSchema = z.discriminatedUnion('action', [
  z.object({ ...common, action: z.literal('create'),
    provider: z.enum(['openai', 'anthropic']),
    name: z.string().trim().min(1).max(200).refine(noNul) }).strict(),
  z.object({ ...common, action: z.literal('key'),
    secretRef: z.string().regex(/^secret:provider-[a-f0-9]{64}$/u) }).strict(),
  z.object({ ...common, action: z.literal('models'), models: z.array(modelId).max(11) }).strict(),
]);
export class ProviderRefused extends Error {}
export class ProviderUnpriced extends ProviderRefused {}
export class ProviderConflict extends Error {}

export async function providerAuthority(store: EventStore, binding: Binding, memberId: string) {
  const fresh = await authorityFence(store, performance.now(), [`member-${memberId}`]);
  const rows = await history(store, `member-${memberId}`, binding.silo, fresh.deadline);
  function isState(row: StoredEvent) {
    return ['member.joined', 'silo.owner_bootstrapped', 'member.role_changed',
      'member.removed'].includes(row.event.type);
  }
  const latest = rows.findLast(isState);
  if (!latest || latest.event.type === 'member.removed') {
    throw new ProviderRefused();
  }
  const role = z.object({ role: z.string().optional(), newRole: z.string().optional() });
  const data = role.parse(latest.event.data);
  if (!['owner', 'admin'].includes(data.newRole ?? data.role ?? '')) {
    throw new ProviderRefused();
  }
  const auth = memberAuthorisation(binding);
  const permission = await auth.check(memberId, 'admin');
  if (permission.status === 'unavailable') {
    throw new Error('IAM unavailable');
  }
  if (!permission.allowed) {
    throw new ProviderRefused();
  }
  for (const row of rows) {
    if (isState(row) && !await auth.applied(row.event.id)) {
      throw new ProviderRefused();
    }
  }
  await fresh();
  return fresh;
}
export function providerReceipt(row: StoredEvent) {
  const data = z.object({ providerId: id, revision: z.int().positive() }).parse(row.event.data);
  return { status: 'appended' as const, ...data, operation: row.event.type,
    sequence: row.sequence, changeId: row.event.id };
}
export function providerSecretRef(silo: string, providerId: string, commandId: string) {
  const identity = JSON.stringify([silo, providerId, commandId]);
  const hash = createHash('sha256');
  hash.update(identity);
  const digest = hash.digest('hex');
  return `secret:provider-${digest}`;
}
export async function providerHistory(store: EventStore, silo: string,
  providerId: string, deadline = Infinity) {
  const rows = await history(store, `provider-${providerId}`, silo, deadline);
  let state: ProviderState | undefined;
  for (const row of rows) {
    state = applyProvider(state, row.event, row.sequence);
  }
  return { rows, state };
}
export async function providerPermission(binding: Binding, memberId: string,
  rows: StoredEvent[]) {
  const created = rows[0];
  if (!created) {
    throw new ProviderRefused();
  }
  const data = z.object({ providerId: id }).parse(created.event.data);
  const auth = memberAuthorisation(binding);
  if (!await auth.applied(created.event.id)) {
    throw new ProviderRefused('Provider is applying');
  }
  const permission = await auth.provider(memberId, data.providerId, 'manage');
  if (permission.status === 'unavailable') {
    throw new Error('IAM unavailable');
  }
  if (!permission.allowed) {
    throw new ProviderRefused();
  }
}
function commandPayload(input: z.infer<typeof providerCommandSchema>, memberId: string) {
  const base = { providerId: input.providerId, revision: input.expectedRevision + 1,
    changedBy: memberId };
  if (input.action === 'create') {
    return { providerId: input.providerId, provider: input.provider, name: input.name,
      revision: base.revision, changedBy: memberId };
  }
  if (input.action === 'key') {
    return { ...base, secretRef: input.secretRef };
  }
  return { ...base, models: input.models };
}
function checkConfiguration(input: z.infer<typeof providerCommandSchema>,
  state: ProviderState | undefined, silo: string) {
  if ((state?.revision ?? 0) !== input.expectedRevision) {
    throw new ProviderConflict();
  }
  if (input.action === 'create') {
    if (state) {
      throw new ProviderConflict();
    }
    return;
  }
  if (!state) {
    throw new ProviderConflict();
  }
  if (input.action === 'key') {
    const expected = providerSecretRef(silo, input.providerId, input.commandId);
    if (input.secretRef !== expected) {
      throw new ProviderRefused();
    }
    return;
  }
  if (!state.secretRef || state.provider !== 'openai') {
    throw new ProviderRefused();
  }
  const unique = new Set(input.models);
  if (unique.size !== input.models.length) {
    throw new ProviderRefused();
  }
  for (const modelId of input.models) {
    function matches(model: (typeof models)[number]) {
      return model.id === modelId && !model.retired;
    }
    if (!models.some(matches)) {
      throw new ProviderRefused();
    }
  }
}
export async function appendProvider(store: EventStore, silo: string, providerId: string,
  memberId: string, commandId: string, type: string, payload: unknown,
  expectedSequence: number, fresh: () => Promise<void>) {
  const subject = `provider-${providerId}`;
  const event = { id: randomUUID(), commandId, subject, silo, type, data: payload,
    time: new Date().toISOString(), source: 'opencrane-server', correlation: {},
    principal: { kind: 'human' as const, id: memberId } };
  await fresh();
  const result = await store.append({ expectedSequence, event });
  if (result.status === 'appended') {
    return providerReceipt({ event, sequence: result.sequence });
  }
  if (result.status === 'conflict') {
    throw new ProviderConflict();
  }
  throw new Error('Provider append unavailable');
}
/** Commands append once. Secret custody and live verification belong to their adapters. */
export async function providerCommand(store: EventStore, binding: Binding,
  memberId: string, raw: unknown, authority?: Awaited<ReturnType<typeof authorityFence>>) {
  const input = providerCommandSchema.parse(raw);
  const fresh = authority ?? await providerAuthority(store, binding, memberId);
  fresh.include(`provider-${input.providerId}`);
  const { rows, state } = await providerHistory(store, binding.silo,
    input.providerId, fresh.deadline);
  function matchesCommand(row: StoredEvent) {
    return row.event.commandId === input.commandId;
  }
  const previous = rows.find(matchesCommand);
  if (input.action !== 'create') {
    await providerPermission(binding, memberId, rows);
  }
  const payload = commandPayload(input, memberId);
  const types = { create: 'provider.created', key: 'provider.key_saved',
    models: 'provider.models_selected' };
  const type = types[input.action];
  if (previous) {
    if (previous.event.type !== type ||
      JSON.stringify(previous.event.data) !== JSON.stringify(payload)) {
      throw new ProviderConflict();
    }
    await fresh();
    return providerReceipt(previous);
  }
  checkConfiguration(input, state, binding.silo);
  return appendProvider(store, binding.silo, input.providerId, memberId, input.commandId,
    type, payload, rows.at(-1)?.sequence ?? 0, fresh);
}
