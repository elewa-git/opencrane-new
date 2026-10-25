import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { providerIdSchema, providerDrainSchema, parseEventByType,
  type EventEnvelope } from '@opencrane/events';
import type { Binding } from '@opencrane/authz';
import { readEventAt, type EventStore, type StoredEvent } from '@opencrane/event-store';
import { applyProvider, type ProviderState } from '@opencrane/projections';
import { readActiveMember } from './member-authority.ts';
import { history } from './actor.ts';
import { appendCheckedState } from './append-checked-state.ts';
import { managedProviderCallsEnabled } from './provider-turns.ts';
import {
  ProviderConflict, ProviderRefused, providerAuthority, providerPermission, providerReceipt,
  reconcileProvider,
} from './providers.ts';

const commandSchema = z.object({
  commandId: providerIdSchema, action: z.enum(['start', 'cancel']),
  expectedRevision: z.int().positive(), expectedProviderSequence: z.int().nonnegative(),
  expectedDrainSequence: z.int().nonnegative(),
}).strict();

async function readDrain(store: EventStore, silo: string, providerId: string) {
  providerIdSchema.parse(providerId);
  const deadline = performance.now() + 10_000;
  const globalSequence = await store.head(undefined, deadline);
  const enabled = await managedProviderCallsEnabled(store, silo, deadline);
  const rows = await history(store, 'provider-*', silo, deadline);
  const connection: StoredEvent[] = [];
  let state: ProviderState | undefined;
  let draining = false;
  let sequence = 0;
  for (const row of rows) {
    const parsed = parseEventByType(row.event);
    if (!parsed.success) {
      throw new Error('Invalid provider history');
    }
    const event = parsed.event;
    if (event.type === 'provider.managed_calls_drain_set') {
      const data = providerDrainSchema.parse(event.data);
      draining = data.draining;
      sequence = row.sequence;
    }
    if (event.subject === `provider-${providerId}`) {
      state = applyProvider(state, event, row.sequence);
      connection.push(row);
    }
  }
  const currentDraining = draining && !enabled;
  return { connection, state, draining: currentDraining, enabled, sequence,
    position: rows.at(-1)?.sequence ?? 0, globalSequence };
}

export async function providerDrainStatus(store: EventStore, binding: Binding,
  memberId: string, providerId: string) {
  const current = await readDrain(store, binding.silo, providerId);
  await readActiveMember(store, binding, memberId, 'admin');
  await providerPermission(binding, memberId, current.connection);
  return { draining: current.draining, enabled: current.enabled, sequence: current.sequence,
    expectedProviderSequence: current.position, revision: current.state?.revision };
}

export async function providerDrainCommand(store: EventStore, binding: Binding,
  memberId: string, providerId: string, raw: unknown) {
  const input = commandSchema.parse(raw);
  // Read configuration before starting the short access check.
  const current = await readDrain(store, binding.silo, providerId);
  const fresh = await providerAuthority(store, binding, memberId);
  await providerPermission(binding, memberId, current.connection);
  function matchesCommand(row: StoredEvent) {
    return row.event.commandId === input.commandId;
  }
  const original = current.connection.find(matchesCommand);
  const data = {
    providerId, revision: input.expectedRevision, changedBy: memberId,
    expectedProviderSequence: input.expectedProviderSequence,
    expectedDrainSequence: input.expectedDrainSequence, draining: input.action === 'start',
  };
  const event: EventEnvelope = {
    id: randomUUID(), commandId: input.commandId, subject: `provider-${providerId}`,
    silo: binding.silo, type: 'provider.managed_calls_drain_set', data,
    time: new Date().toISOString(), source: 'opencrane-server', correlation: {},
    principal: { kind: 'human', id: memberId },
  };
  if (original) {
    reconcileProvider(original, event);
    await fresh();
    return providerReceipt(original);
  }
  // Keep cancellation from ever undoing switch-on or selecting a fallback key.
  if (current.enabled) {
    throw new ProviderRefused('Managed calls have already been switched on');
  }
  if (current.position !== input.expectedProviderSequence ||
    current.state?.revision !== input.expectedRevision ||
    current.sequence !== input.expectedDrainSequence || current.draining === data.draining) {
    throw new ProviderConflict();
  }
  const command = {
    event, expectedSequence: current.position, expectedSubject: 'provider-*',
    // Refuse switch-on saved on the budget stream before this drain append.
    expectedGlobalSequence: current.globalSequence,
    historyChecked: true as const, deadline: fresh.deadline,
  };
  async function unchanged() {
    const position = await store.head('provider-*', fresh.deadline);
    const enabled = await managedProviderCallsEnabled(store, binding.silo, fresh.deadline);
    await fresh();
    return position === current.position && !enabled;
  }
  const result = await appendCheckedState(store, command, unchanged);
  if (result.status === 'conflict') {
    throw new ProviderConflict();
  }
  if (result.status !== 'appended') {
    throw new Error('Drain append unavailable');
  }
  const saved = await readEventAt(store, event.subject, result.sequence, performance.now() + 10_000);
  if (!saved) {
    throw new Error('Saved drain unavailable');
  }
  reconcileProvider(saved, event);
  return providerReceipt(saved);
}
