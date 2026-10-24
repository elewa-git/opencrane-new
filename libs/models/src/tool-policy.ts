import { publicationEntry, publicationDigest } from './publication.ts';
import { authorityFence } from './authority.ts';
import { currentMembership } from './ownership.ts';
import { readActiveMember } from './member-authority.ts';
import { z } from 'zod';
import type { EventStore, StoredEvent } from '@opencrane/event-store';
import { losslessJson } from '@opencrane/events/lossless-json';
import { mcpServerReviewedDataSchema, mcpPublicationIntentDataSchema,
  mcpToolModeSetDataSchema } from '@opencrane/events';
import { applyToolPolicy, emptyToolPolicy, isToolPolicyAvailable, isToolReviewCurrent,
  reviewedToolChoices } from '@opencrane/projections';
import { memberAuthorisation, type Binding } from '@opencrane/authz';
import { envelope, history } from './actor.ts';

export function toolPolicyFromRows(rows: StoredEvent[]) {
  const policy = foldPolicy(rows);
  return { ...policy, published: isToolPolicyAvailable(policy) };
}

function foldPolicy(rows: StoredEvent[]) {
  let policy = emptyToolPolicy();
  for (const row of rows) {
    policy = applyToolPolicy(policy, row.event, row.sequence);
  }
  return policy;
}

export async function readToolPolicy(store: EventStore, silo: string, serverId: string,
  deadline = Infinity) {
  const rows = await history(store, `mcp-${serverId}`, silo, deadline);
  return toolPolicyFromRows(rows);
}
const id = z.string().regex(/^[\w-]{1,200}$/u);
const commandFields = { commandId: id, expectedSequence: z.int().nonnegative() };
const input = z.object({ ...commandFields, connectionId: id,
  toolName: z.string().min(1).max(200), toolRevision: z.string().regex(/^[a-f0-9]{64}$/u),
  mode: z.enum(['allow', 'ask', 'block']) }).strict();
const reviewFields = mcpServerReviewedDataSchema.omit({ serverId: true, reviewedBy: true });
const reviewInput = reviewFields.extend(commandFields);

export async function reviewToolPolicy(store: EventStore, binding: Binding, memberId: string,
  serverId: string, raw: unknown) {
  const command = reviewInput.parse(raw);
  const { commandId, expectedSequence, ...review } = command;
  const payload = { ...review, serverId, reviewedBy: memberId };
  // Read definitions before starting the short access check.
  const deadline = performance.now() + 10_000;
  const rows = await history(store, `mcp-${serverId}`, binding.silo, deadline);
  const state = foldPolicy(rows);
  const tools = reviewedToolChoices(state, payload, Date.now());
  const valid = state.sequence === expectedSequence && tools !== null;
  const reference = { commandId, expectedSequence };
  const expiresAt = Date.parse(state.expiresAt ?? '');
  const result = await saveToolCommand(store, binding, memberId, serverId, 'mcp.server_reviewed',
    payload, reference, rows, valid, expiresAt);
  if (result.status !== 'appended' || !('sequence' in result)) {
    return result;
  }
  return savedToolPolicyResult(store, binding.silo, memberId, serverId, reference,
    'mcp.server_reviewed', payload, rows, result.sequence);
}

const publicationInput = z.strictObject({ ...commandFields, reviewRevision: z.int().positive() });

export async function publishToolPolicy(store: EventStore, binding: Binding, memberId: string,
  serverId: string, raw: unknown) {
  const command = publicationInput.parse(raw);
  const rows = await history(store, `mcp-${serverId}`, binding.silo, performance.now() + 10_000);
  const state = foldPolicy(rows);
  const entry = publicationEntry(state);
  function matchesCommand(row: StoredEvent) {
    return row.event.commandId === command.commandId;
  }
  const prior = rows.find(matchesCommand);
  const original = mcpPublicationIntentDataSchema.safeParse(prior?.event.data);
  let fragmentDigest = '0'.repeat(64);
  if (original.success) {
    fragmentDigest = original.data.fragmentDigest;
  } else if (entry) {
    fragmentDigest = publicationDigest(entry);
  }
  const payload = { ...command, serverId, publishedBy: memberId, fragmentDigest };
  const valid = entry !== null && command.reviewRevision === state.reviewRevision &&
    command.expectedSequence === state.sequence;
  const result = await saveToolCommand(store, binding, memberId, serverId, 'mcp.server_published',
    payload, command, rows, valid, Date.parse(state.expiresAt ?? ''));
  if (result.status !== 'appended' || !('sequence' in result)) {
    return result;
  }
  // Check duplicate recovery against the event actually saved by the store.
  const saved = await store.readEvent(result.sequence);
  if (!matchesPublication(saved, binding.silo, serverId, memberId, payload)) {
    return { status: 'conflict' };
  }
  return { status: 'appended', sequence: result.sequence };
}

function matchesPublication(row: StoredEvent, silo: string, serverId: string,
  memberId: string, payload: { commandId: string }) {
  const event = row.event;
  return event.silo === silo && event.subject === `mcp-${serverId}` &&
    event.principal?.kind === 'human' && event.principal.id === memberId &&
    event.commandId === payload.commandId && event.type === 'mcp.server_published' &&
    publicationDigest(event.data) === publicationDigest(payload);
}

export async function setToolPolicy(store: EventStore, binding: Binding, memberId: string,
  serverId: string, raw: unknown) {
  const command = input.parse(raw);
  const deadline = performance.now() + 10_000;
  const rows = await history(store, `mcp-${serverId}`, binding.silo, deadline);
  const state = foldPolicy(rows);
  const payload = { serverId, connectionId: command.connectionId, toolName: command.toolName,
    toolRevision: command.toolRevision, mode: command.mode, setBy: memberId };
  function matchesName(tool: { name: string }) {
    return tool.name === command.toolName;
  }
  const tool = state.tools.find(matchesName);
  const declaration = state.catalogue?.tools?.find(matchesName);
  const safeChoice = command.mode === 'block' || (tool?.costCents === 0 &&
    declaration?.review !== undefined);
  const valid = state.sequence === command.expectedSequence &&
    state.connectionId === command.connectionId && tool?.reviewed === true &&
    tool.revision === command.toolRevision && safeChoice;
  const result = await saveToolCommand(store, binding, memberId, serverId, 'mcp.tool_mode_set',
    payload, command, rows, valid);
  if (result.status !== 'appended' || !('sequence' in result)) {
    return result;
  }
  return savedToolPolicyResult(store, binding.silo, memberId, serverId, command,
    'mcp.tool_mode_set', payload, rows, result.sequence);
}

async function savedToolPolicyResult(store: EventStore, silo: string, memberId: string,
  serverId: string, command: { commandId: string; expectedSequence: number },
  type: 'mcp.tool_mode_set' | 'mcp.server_reviewed', payload: Record<string, unknown>,
  rows: StoredEvent[], sequence: number) {
  // Read the stored event so broker deduplication cannot confirm a different save.
  const saved = await store.readEvent(sequence, performance.now() + 10_000);
  const receipt = toolChangeReceipt(saved, silo, serverId, memberId, command.commandId);
  // Recover the original write position without adding fields to existing events.
  let originalSequence = 0;
  for (const row of rows) {
    if (row.sequence < saved.sequence) {
      originalSequence = row.sequence;
    }
  }
  if (!receipt || saved.event.type !== type || originalSequence !== command.expectedSequence ||
      publicationDigest(saved.event.data) !== publicationDigest(payload)) {
    return { status: 'conflict' };
  }
  return { status: 'appended', sequence, receipt };
}

function toolChangeReceipt(row: StoredEvent, silo: string, serverId: string,
  memberId: string, changeRef: string) {
  const event = row.event;
  if (event.silo !== silo || event.subject !== `mcp-${serverId}` ||
      event.id !== changeRef || event.commandId !== changeRef ||
      event.source !== 'opencrane-server' ||
      event.principal?.kind !== 'human' || event.principal.id !== memberId) {
    return null;
  }
  if (event.type === 'mcp.server_reviewed') {
    return toolReviewReceipt(row, serverId, memberId, changeRef);
  }
  if (event.type !== 'mcp.tool_mode_set') {
    return null;
  }
  return toolModeReceipt(row, serverId, memberId, changeRef);
}

function toolModeReceipt(row: StoredEvent, serverId: string, memberId: string,
  changeRef: string) {
  const event = row.event;
  const parsed = mcpToolModeSetDataSchema.safeParse(event.data);
  if (!parsed.success || parsed.data.serverId !== serverId || parsed.data.setBy !== memberId ||
      !parsed.data.connectionId || !parsed.data.toolRevision) {
    return null;
  }
  const data = parsed.data;
  return { changeRef, eventId: event.id, recordedAt: event.time, sequence: row.sequence,
    serverId, connectionId: data.connectionId, toolRevision: data.toolRevision,
    mode: data.mode, setBy: data.setBy };
}

function toolReviewReceipt(row: StoredEvent, serverId: string, memberId: string,
  changeRef: string) {
  const parsed = mcpServerReviewedDataSchema.safeParse(row.event.data);
  if (!parsed.success || parsed.data.serverId !== serverId || parsed.data.reviewedBy !== memberId) {
    return null;
  }
  const data = parsed.data;
  // Return only saved review facts, without tool definitions or approval descriptions.
  return { changeRef, eventId: row.event.id, recordedAt: row.event.time, sequence: row.sequence,
    serverId, connectionId: data.connectionId, catalogueDigest: data.catalogueDigest,
    policyRevision: data.policyRevision, reviewRevision: row.sequence, reviewedBy: data.reviewedBy };
}

export async function readToolModeChange(store: EventStore, binding: Binding, memberId: string,
  serverId: string, changeRef: string) {
  try {
    return await loadToolModeChange(store, binding.silo, memberId, serverId, changeRef);
  } finally {
    // Check access after successful or failed loading, without a write deadline.
    await readActiveMember(store, binding, memberId, 'admin');
  }
}

async function loadToolModeChange(store: EventStore, silo: string, memberId: string,
  serverId: string, changeRef: string) {
  const deadline = performance.now() + 10_000;
  const rows: StoredEvent[] = [];
  for await (const row of store.readStream(`mcp-${serverId}`, 1, deadline)) {
    if (row.event.silo !== silo || row.event.subject !== `mcp-${serverId}`) {
      return { status: 'unknown' };
    }
    rows.push(row);
  }
  if (performance.now() > deadline) {
    throw new Error('Tool change unavailable');
  }
  function matchesId(row: StoredEvent) {
    return row.event.id === changeRef;
  }
  const saved = rows.find(matchesId);
  const receipt = saved && toolChangeReceipt(saved, silo, serverId, memberId, changeRef);
  if (!receipt) {
    return { status: 'unknown' };
  }
  const policy = toolPolicyFromRows(rows);
  const current = isToolReviewCurrent(policy) && isToolPolicyAvailable(policy);
  // Keep the saved choice separate from today's availability and requester permissions.
  const availability = { status: 'unavailable', reason: 'requester_assistant_required',
    policy: current ? 'current' : 'unavailable', sequence: policy.sequence };
  return { status: 'appended', receipt, availability };
}

export async function saveToolCommand(store: EventStore, binding: Binding, memberId: string,
  serverId: string, type: string, payload: Record<string, unknown>,
  command: { commandId: string; expectedSequence: number }, rows: StoredEvent[], valid: boolean,
  expiresAt = Infinity) {
  const auth = memberAuthorisation(binding);
  const permission = await auth.check(memberId, 'admin');
  if (!permission.allowed) {
    throw new Error('Access changed');
  }
  const fresh = await authorityFence(store, performance.now());
  const membership = await currentMembership(store, binding.silo, memberId, fresh);
  if (!['owner', 'admin'].includes(membership.role)) {
    throw new Error('Access changed');
  }
  for (const row of membership.facts) {
    if (!await auth.applied(row.event.id)) {
      throw new Error('IAM projection behind');
    }
  }
  function matchesCommand(row: StoredEvent) {
    return row.event.commandId === command.commandId;
  }
  const prior = rows.find(matchesCommand);
  if (prior) {
    const savedData = JSON.stringify(prior.event.data);
    const payloadData = JSON.stringify(payload);
    const savedDigest = losslessJson(savedData).digest;
    const payloadDigest = losslessJson(payloadData).digest;
    const samePayload = savedDigest === payloadDigest;
    const sameActor = prior.event.principal?.kind === 'human' &&
      prior.event.principal.id === memberId;
    const status = samePayload && sameActor && prior.event.type === type ? 'appended' : 'conflict';
    await fresh();
    return { status, sequence: prior.sequence };
  }
  if (!valid) {
    return { status: 'conflict' };
  }
  const event = { ...envelope(binding.silo, `mcp-${serverId}`, type, payload, command.commandId),
    principal: { kind: 'human' as const, id: memberId }, source: 'opencrane-server' };
  await fresh();
  if (Date.now() >= expiresAt) {
    return { status: 'conflict' };
  }
  const deadline = Math.min(fresh.deadline, performance.now() + expiresAt - Date.now());
  // Reuse the history already read and recheck access immediately before publishing.
  const append = { event, expectedSequence: command.expectedSequence, deadline,
    historyChecked: true as const, checkAccess: fresh };
  return store.append(append);
}
