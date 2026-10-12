import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { Binding } from '@opencrane/authz';
import { readEventAt, type EventStore, type StoredEvent } from '@opencrane/event-store';
import { mcpInstanceStartSchema, mcpInstanceStopSchema,
  type EventEnvelope } from '@opencrane/events';
import { applyMcpInstance, type McpInstanceState } from '@opencrane/projections';
import { history } from './actor.ts';
import { authorityFence } from './authority.ts';
import { activeMember, readActiveMember } from './member-authority.ts';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/u);
const referenceSchema = z.strictObject({ instanceId: z.string().regex(/^[a-f0-9]{64}$/u),
  profileId: id, serverId: id });
const commandSchema = z.strictObject({ action: z.enum(['wake', 'stop']), changeRef: id,
  expectedSequence: z.int().nonnegative(), runGeneration: z.int().positive().optional() });

export class McpInstanceRefused extends Error {
  readonly reason: 'reference' | 'conflict' | 'profile_or_admission_unavailable';

  constructor(reason: McpInstanceRefused['reason'], message: string) {
    super(message);
    this.reason = reason;
  }
}

export async function readMcpInstance(store: EventStore, silo: string, raw: unknown) {
  const reference = referenceSchema.parse(raw);
  let rows: StoredEvent[];
  try {
    rows = await history(store, `mcp-instance-${reference.instanceId}`, silo,
      performance.now() + 10_000);
  } catch (error) {
    // Hide another silo's stream in the same way as a missing instance.
    if (error instanceof Error && error.message === 'Wrong silo') {
      throw new McpInstanceRefused('reference', 'Instance silo mismatch');
    }
    throw error;
  }
  let state: McpInstanceState | undefined;
  for (const row of rows) state = applyMcpInstance(state, row.event, row.sequence);
  if (!state || state.start.siloId !== silo ||
      state.start.profileId !== reference.profileId || state.start.serverId !== reference.serverId) {
    throw new McpInstanceRefused('reference', 'Instance owner or reference mismatch');
  }
  return { rows, state };
}

async function ownInstance(store: EventStore, binding: Binding, memberId: string, raw: unknown) {
  const current = await readMcpInstance(store, binding.silo, raw);
  if (current.state.start.userId !== memberId) {
    throw new McpInstanceRefused('reference', 'Instance owner mismatch');
  }
  return current;
}

export async function mcpInstanceStatus(store: EventStore, binding: Binding,
  memberId: string, reference: unknown) {
  const { state } = await ownInstance(store, binding, memberId, reference);
  await readActiveMember(store, binding, memberId);
  let phase = state.phase;
  let reason: string | undefined = state.reason;
  if (phase === 'waking' && Date.parse(state.start.deadline) <= Date.now()) {
    phase = 'unavailable';
    reason = 'wake_deadline_exceeded';
  }
  return { state: phase, runGeneration: state.start.runGeneration, sequence: state.sequence,
    changeRef: state.start.changeRef, requestedAt: state.start.requestedAt,
    deadline: state.start.deadline, reason };
}

function matchesChange(row: StoredEvent, changeRef: string) {
  if (row.event.type === 'mcp.instance_start_requested') {
    return mcpInstanceStartSchema.parse(row.event.data).changeRef === changeRef;
  }
  if (row.event.type === 'mcp.instance_stop_requested') {
    return mcpInstanceStopSchema.parse(row.event.data).changeRef === changeRef;
  }
  return false;
}
function receipt(row: StoredEvent) {
  const schema = row.event.type === 'mcp.instance_start_requested'
    ? mcpInstanceStartSchema : mcpInstanceStopSchema;
  const data = schema.parse(row.event.data);
  return { status: 'applied' as const, operation: row.event.type, changeRef: data.changeRef,
    sequence: row.sequence, runGeneration: data.runGeneration };
}

function reconcileStop(saved: StoredEvent, attempted: EventEnvelope) {
  const event = saved.event;
  if (event.silo !== attempted.silo || event.subject !== attempted.subject ||
      event.commandId !== attempted.commandId || event.type !== attempted.type ||
      event.principal?.kind !== attempted.principal?.kind ||
      event.principal?.id !== attempted.principal?.id) {
    throw new McpInstanceRefused('conflict', 'Instance change payload mismatch');
  }
  const savedPayload = mcpInstanceStopSchema.parse(event.data);
  const attemptedPayload = mcpInstanceStopSchema.parse(attempted.data);
  if (JSON.stringify(savedPayload) !== JSON.stringify(attemptedPayload)) {
    throw new McpInstanceRefused('conflict', 'Instance change payload mismatch');
  }
}

export async function mcpInstanceChange(store: EventStore, binding: Binding,
  memberId: string, reference: unknown, changeRef: string) {
  id.parse(changeRef);
  const current = await ownInstance(store, binding, memberId, reference);
  await readActiveMember(store, binding, memberId);
  function originalChange(row: StoredEvent) {
    return matchesChange(row, changeRef);
  }
  const original = current.rows.find(originalChange);
  if (!original) return { status: 'unknown' as const };
  return receipt(original);
}

export async function mcpInstanceCommand(store: EventStore, binding: Binding,
  memberId: string, reference: unknown, raw: unknown) {
  const input = commandSchema.parse(raw);
  const current = await ownInstance(store, binding, memberId, reference);
  const fresh = await authorityFence(store, performance.now(), [`member-${memberId}`]);
  const authority = { requiredRole: 'member' as const, fresh };
  await activeMember(store, binding, memberId, authority);
  // Keep all installation on the shared hosted path until its admission and profiles are usable.
  if (input.action === 'wake') {
    throw new McpInstanceRefused('profile_or_admission_unavailable',
      'profile_or_admission_unavailable');
  }
  const runGeneration = input.runGeneration ?? current.state.start.runGeneration;
  const data = { instanceId: current.state.start.instanceId, runGeneration,
    startChangeRef: current.state.start.changeRef, changeRef: input.changeRef,
    expectedSequence: input.expectedSequence, requestedBy: memberId, reason: 'owner_stop' as const };
  function originalChange(row: StoredEvent) {
    return matchesChange(row, input.changeRef);
  }
  const original = current.rows.find(originalChange);
  if (original) {
    if (original.event.type !== 'mcp.instance_stop_requested') {
      throw new McpInstanceRefused('conflict', 'Instance change payload mismatch');
    }
    const saved = mcpInstanceStopSchema.parse(original.event.data);
    data.startChangeRef = saved.startChangeRef;
    // Derive browser retries from their saved run, even after a later run has started.
    if (input.runGeneration === undefined) {
      data.runGeneration = saved.runGeneration;
    }
    if (JSON.stringify(saved) !== JSON.stringify(mcpInstanceStopSchema.parse(data))) {
      throw new McpInstanceRefused('conflict', 'Instance change payload mismatch');
    }
    await fresh();
    return receipt(original);
  }
  if (input.expectedSequence !== current.state.sequence ||
      runGeneration !== current.state.start.runGeneration ||
      current.state.phase === 'sleeping' || current.state.phase === 'stopping') {
    throw new McpInstanceRefused('conflict', 'Instance revision or run mismatch');
  }
  const subject = `mcp-instance-${current.state.start.instanceId}`;
  const event = { id: randomUUID(), commandId: input.changeRef,
    silo: binding.silo, subject, type: 'mcp.instance_stop_requested', data,
    time: new Date().toISOString(), source: 'opencrane-server', correlation: {},
    principal: { kind: 'human' as const, id: memberId } };
  const command = { event, expectedSequence: current.state.sequence,
    historyChecked: true as const, deadline: fresh.deadline };
  await fresh();
  const result = await store.append(command);
  if (result.status !== 'appended') throw new Error('Instance append unconfirmed');
  // Check the saved stop because concurrent recovery can return another request's position.
  const saved = await readEventAt(store, subject, result.sequence, performance.now() + 10_000);
  if (!saved) throw new Error('Saved instance change unavailable');
  reconcileStop(saved, event);
  return receipt(saved);
}
